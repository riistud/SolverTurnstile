import connectRealBrowser from "puppeteer-real-browser"
import os from "os"
import fs from "fs"
import path from "path"
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class CustomLogger {
  constructor(context) {
    this.context = context
  }

  getTimestamp() {
    return new Date().toISOString().replace("T", " ").substring(0, 19)
  }

  info(message, ...args) {
    console.log(`\x1b[34mINFO\x1b[0m [${this.getTimestamp()}] [${this.context}] | ${message}`, ...args)
  }

  warn(message, ...args) {
    console.log(`\x1b[33mWARN\x1b[0m [${this.getTimestamp()}] [${this.context}] | ${message}`, ...args)
  }

  error(message, ...args) {
    console.log(`\x1b[31mERROR\x1b[0m [${this.getTimestamp()}] [${this.context}] | ${message}`, ...args)
  }

  success(message, ...args) {
    console.log(`\x1b[32mSUCCESS\x1b[0m [${this.getTimestamp()}] [${this.context}] | ${message}`, ...args)
  }

  debug(message, ...args) {
    if (process.env.NODE_ENV === "development") {
      console.log(`\x1b[35mDEBUG\x1b[0m [${this.getTimestamp()}] [${this.context}] | ${message}`, ...args)
    }
  }
}

class BrowserService {
  constructor() {
    this.logger = new CustomLogger("Browser")
    this.browser = null
    this.browserContexts = new Set()
    this.cleanupTimer = null
    this.isShuttingDown = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.contextLimit = Math.max(os.cpus().length * 4, 16)
    this.cleanupInterval = 30000
    this.contextTimeout = 300000
    this.contextCreationTimes = new Map()
    this.stats = {
      totalContexts: 0,
      activeContexts: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      lastCleanup: Date.now(),
    }

    this.logger.info(`Browser service initialized with context limit: ${this.contextLimit}`)
    if (process.env.VERCEL !== '1') {
      this.setupGracefulShutdown()
      this.startPeriodicCleanup()
    }
  }

  async initialize(options = {}) {
    if (this.isShuttingDown) return

    try {
      await this.closeBrowser()
      this.logger.info("Launching browser...")

      const width = options.width || 1024
      const height = options.height || 768

      const connectOption = {
        defaultViewport: { width, height },
        timeout: 120000,
        protocolTimeout: 300000,
        args: [
          `--window-size=${width},${height}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--disable-extensions",
          "--disable-sync",
          "--disable-translate",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
        ],
      }

      if (process.env.VERCEL === '1') {
        this.logger.warn("Running in serverless environment mode")
      }

      const { browser } = await connectRealBrowser.connect({
        headless: true,
        turnstile: true,
        connectOption,
        disableXvfb: false,
      })

      if (!browser) {
        throw new Error("Failed to connect to browser")
      }

      this.browser = browser
      this.reconnectAttempts = 0
      this.setupBrowserEventHandlers()
      this.wrapBrowserMethods()

      this.logger.success("Browser launched successfully")
    } catch (error) {
      this.logger.error("Browser initialization failed:", error)

      if (this.reconnectAttempts < this.maxReconnectAttempts && !this.isShuttingDown) {
        this.reconnectAttempts++
        this.logger.warn(`Retrying browser initialization (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
        await new Promise((resolve) => setTimeout(resolve, 5000 * this.reconnectAttempts))
        return this.initialize(options)
      }

      throw error
    }
  }

  setupBrowserEventHandlers() {
    if (!this.browser) return

    this.browser.on("disconnected", async () => {
      if (this.isShuttingDown) return
      this.logger.warn("Browser disconnected, attempting to reconnect...")
      await this.handleBrowserDisconnection()
    })

    this.browser.on("targetcreated", () => this.updateStats())
    this.browser.on("targetdestroyed", () => this.updateStats())
  }

  wrapBrowserMethods() {
    if (!this.browser) return

    const originalCreateContext = this.browser.createBrowserContext.bind(this.browser)

    this.browser.createBrowserContext = async (...args) => {
      if (this.browserContexts.size >= this.contextLimit) {
        await this.forceCleanupOldContexts()
        if (this.browserContexts.size >= this.contextLimit) {
          throw new Error(`Browser context limit reached (${this.contextLimit})`)
        }
      }

      const context = await originalCreateContext(...args)

      if (context) {
        this.browserContexts.add(context)
        this.contextCreationTimes.set(context, Date.now())
        this.stats.totalContexts++

        const originalClose = context.close.bind(context)
        context.close = async () => {
          try {
            await originalClose()
          } catch (error) {
            this.logger.warn("Error closing context:", error.message)
          } finally {
            this.browserContexts.delete(context)
            this.contextCreationTimes.delete(context)
            this.updateStats()
          }
        }

        setTimeout(async () => {
          if (this.browserContexts.has(context)) {
            this.logger.debug("Force closing expired context")
            try {
              await context.close()
            } catch (error) {}
          }
        }, this.contextTimeout)
      }

      this.updateStats()
      return context
    }
  }

  async handleBrowserDisconnection() {
    try {
      const cleanupPromises = Array.from(this.browserContexts).map((context) => context.close().catch(() => {}))
      await Promise.allSettled(cleanupPromises)
      this.browserContexts.clear()
      this.contextCreationTimes.clear()

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        await this.initialize()
      } else {
        this.logger.error("Max reconnection attempts reached")
      }
    } catch (error) {
      this.logger.error("Error handling browser disconnection:", error)
    }
  }

  startPeriodicCleanup() {
    this.cleanupTimer = setInterval(async () => {
      if (this.isShuttingDown) return
      try {
        await this.performCleanup()
        this.updateStats()
      } catch (error) {
        this.logger.error("Periodic cleanup error:", error)
      }
    }, this.cleanupInterval)
  }

  async performCleanup() {
    const now = Date.now()
    const contextsToCleanup = []

    for (const [context, creationTime] of this.contextCreationTimes.entries()) {
      if (now - creationTime > this.contextTimeout) {
        contextsToCleanup.push(context)
      }
    }

    if (contextsToCleanup.length > 0) {
      this.logger.debug(`Cleaning up ${contextsToCleanup.length} expired contexts`)
      const cleanupPromises = contextsToCleanup.map((context) => context.close().catch(() => {}))
      await Promise.allSettled(cleanupPromises)
    }

    if (this.browserContexts.size > this.contextLimit * 0.8) {
      await this.forceCleanupOldContexts()
    }

    this.stats.lastCleanup = now
  }

  async forceCleanupOldContexts() {
    const contextsArray = Array.from(this.browserContexts)
    const sortedContexts = contextsArray.sort((a, b) => {
      const timeA = this.contextCreationTimes.get(a) || 0
      const timeB = this.contextCreationTimes.get(b) || 0
      return timeA - timeB
    })

    const toCleanup = sortedContexts.slice(0, Math.floor(sortedContexts.length * 0.3))

    if (toCleanup.length > 0) {
      this.logger.warn(`Force cleaning up ${toCleanup.length} contexts due to limit`)
      const cleanupPromises = toCleanup.map((context) => context.close().catch(() => {}))
      await Promise.allSettled(cleanupPromises)
    }
  }

  updateStats() {
    this.stats.activeContexts = this.browserContexts.size
    this.stats.memoryUsage = process.memoryUsage().heapUsed
    const usage = process.cpuUsage()
    this.stats.cpuUsage = (usage.user + usage.system) / 1000000
  }

  async createContext(options = {}) {
    if (!this.browser) {
      await this.initialize()
    }
    if (!this.browser) {
      throw new Error("Browser not available")
    }
    return await this.browser.createBrowserContext({
      ...options,
      ignoreHTTPSErrors: true,
    })
  }

  async withBrowserContext(callback) {
    let context = null
    try {
      context = await this.createContext()
      return await callback(context)
    } finally {
      if (context) {
        try {
          await context.close()
        } catch (error) {
          this.logger.warn(`Failed to close context: ${error.message}`)
        }
      }
    }
  }

  getBrowserStats() {
    return { ...this.stats }
  }

  isReady() {
    return this.browser !== null && !this.isShuttingDown
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        const cleanupPromises = Array.from(this.browserContexts).map((context) => context.close().catch(() => {}))
        await Promise.allSettled(cleanupPromises)
        this.browserContexts.clear()
        this.contextCreationTimes.clear()
        await this.browser.close()
        this.logger.info("Browser closed successfully")
      } catch (error) {
        this.logger.error("Error closing browser:", error)
      } finally {
        this.browser = null
      }
    }
  }

  setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
      this.logger.warn(`Received ${signal}, shutting down browser service...`)
      this.isShuttingDown = true
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer)
      }
      await this.closeBrowser()
      this.logger.success("Browser service shutdown complete")
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
    process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  }

  async shutdown() {
    this.isShuttingDown = true
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
    await this.closeBrowser()
  }
}

class BypassService {
  constructor(browserService) {
    this.logger = new CustomLogger("Bypass")
    this.browserService = browserService
    this.fakePageContent = this.loadFakePage()
  }

  loadFakePage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
</head>
<body>
    <div class="turnstile"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
    <script>
        window.onloadTurnstileCallback = function () {
            turnstile.render('.turnstile', {
                sitekey: '<site-key>',
                callback: function (token) {
                    var c = document.createElement('input');
                    c.type = 'hidden';
                    c.name = 'cf-response';
                    c.value = token;
                    document.body.appendChild(c);
                },
            });
        };
    </script>
</body>
</html>`
  }

  async solveTurnstileMin(url, siteKey, proxy = null, timeout = 60000) {
    const startTime = Date.now()
    try {
      if (!url || !siteKey) {
        throw new Error("Missing url or siteKey parameter")
      }

      const token = await this.browserService.withBrowserContext(async (context) => {
        const page = await context.newPage()

        if (proxy?.username && proxy?.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          })
        }

        await page.setRequestInterception(true)

        page.on("request", async (request) => {
          if ([url, url + "/"].includes(request.url()) && request.resourceType() === "document") {
            await request.respond({
              status: 200,
              contentType: "text/html",
              body: this.fakePageContent.replace(/<site-key>/g, siteKey),
            })
          } else {
            await request.continue()
          }
        })

        await page.goto(url, {
          waitUntil: "domcontentloaded",
        })

        await page.waitForSelector('[name="cf-response"]', {
          timeout: timeout,
        })

        return page.evaluate(() => {
          try {
            return document.querySelector('[name="cf-response"]')?.value
          } catch (e) {
            return null
          }
        })
      })

      if (!token || token.length < 10) {
        throw new Error("Failed to get token")
      }

      return {
        success: true,
        data: token,
        duration: Date.now() - startTime,
      }
    } catch (error) {
      this.logger.error("Turnstile min solve error:", error)
      return {
        success: false,
        error: error.message || "Unknown error",
        duration: Date.now() - startTime,
      }
    }
  }

  async wafSession(url, proxy = null, timeout = 60000) {
    const startTime = Date.now()
    try {
      if (!url) {
        throw new Error("Missing url parameter")
      }

      const result = await this.browserService.withBrowserContext(async (context) => {
        const page = await context.newPage()
        await page.setDefaultTimeout(30000)
        await page.setDefaultNavigationTimeout(30000)

        if (proxy?.username && proxy?.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          })
        }

        await page.setRequestInterception(true)

        let resolved = false
        return new Promise((resolve, reject) => {
          const timeoutHandler = setTimeout(() => {
            if (!resolved) {
              resolved = true
              reject(new Error("Timeout Error"))
            }
          }, timeout)

          page.on("request", async (request) => {
            try {
              await request.continue()
            } catch (e) {}
          })

          page.on("response", async (res) => {
            try {
              if (!resolved && [200, 302].includes(res.status()) && [url, url + "/"].includes(res.url())) {
                await page.waitForNavigation({ waitUntil: "load", timeout: 5000 }).catch(() => {})
                const cookies = await page.cookies()
                const headers = await res.request().headers()
                delete headers["content-type"]
                delete headers["accept-encoding"]
                delete headers["accept"]
                delete headers["content-length"]
                resolved = true
                clearTimeout(timeoutHandler)
                resolve({ cookies, headers })
              }
            } catch (error) {
              if (!resolved) {
                resolved = true
                clearTimeout(timeoutHandler)
                reject(error)
              }
            }
          })

          page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeoutHandler)
              reject(error)
            }
          })
        })
      })

      return {
        success: true,
        data: result,
        duration: Date.now() - startTime,
      }
    } catch (error) {
      this.logger.error("WAF session error:", error)
      return {
        success: false,
        error: error.message || "Unknown error",
        duration: Date.now() - startTime,
      }
    }
  }

  async getSource(url, proxy = null, timeout = 60000) {
    const startTime = Date.now()
    try {
      if (!url) {
        throw new Error("Missing url parameter")
      }

      const result = await this.browserService.withBrowserContext(async (context) => {
        const page = await context.newPage()
        await page.setDefaultTimeout(30000)
        await page.setDefaultNavigationTimeout(30000)

        if (proxy?.username && proxy?.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          })
        }

        await page.setRequestInterception(true)

        let resolved = false
        return new Promise((resolve, reject) => {
          const timeoutHandler = setTimeout(() => {
            if (!resolved) {
              resolved = true
              reject(new Error("Timeout Error"))
            }
          }, timeout)

          page.on("request", async (request) => {
            try {
              await request.continue()
            } catch (e) {}
          })

          page.on("response", async (res) => {
            try {
              if (!resolved && [200, 302].includes(res.status()) && [url, url + "/"].includes(res.url())) {
                await page.waitForNavigation({ waitUntil: "load", timeout: 5000 }).catch(() => {})
                const html = await page.content()
                resolved = true
                clearTimeout(timeoutHandler)
                resolve(html)
              }
            } catch (error) {
              if (!resolved) {
                resolved = true
                clearTimeout(timeoutHandler)
                reject(error)
              }
            }
          })

          page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeoutHandler)
              reject(error)
            }
          })
        })
      })

      return {
        success: true,
        data: result,
        duration: Date.now() - startTime,
      }
    } catch (error) {
      this.logger.error("Get source error:", error)
      return {
        success: false,
        error: error.message || "Unknown error",
        duration: Date.now() - startTime,
      }
    }
  }

  getStats() {
    return this.browserService.getBrowserStats()
  }
}

const browserService = new BrowserService()
const bypassService = new BypassService(browserService)

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

const validateTurnstileRequest = (source = 'query') => {
  return (req, res, next) => {
    const params = source === 'query' ? req.query : req.body
    const { url, sitekey } = params

    const errors = []

    if (!url) {
      errors.push('URL parameter is required')
    } else if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push('URL must be a non-empty string')
    } else {
      try {
        new URL(url.trim())
      } catch {
        errors.push('Invalid URL format')
      }
    }

    if (!sitekey) {
      errors.push('Sitekey parameter is required')
    } else if (typeof sitekey !== 'string' || sitekey.trim().length === 0) {
      errors.push('Sitekey must be a non-empty string')
    }

    if (errors.length > 0) {
      return res.status(400).json({
        status: false,
        errors,
        code: 400,
        creator: "RiiCODE",
        timestamp: new Date().toISOString()
      })
    }

    req.validated = {
      url: url.trim(),
      sitekey: sitekey.trim()
    }

    next()
  }
}

async function handleTurnstileSolver(req, res) {
  const startTime = Date.now()

  try {
    const { url, sitekey } = req.validated
    const { proxy } = req.body || req.query || {}

    const result = await bypassService.solveTurnstileMin(url, sitekey, proxy, 60000)

    const duration = Date.now() - startTime

    if (!result.success) {
      return res.status(500).json({
        status: false,
        error: result.error || 'Failed to solve Turnstile challenge',
        code: 500,
        duration: `${duration}ms`,
        creator: "RiiCODE",
        timestamp: new Date().toISOString()
      })
    }

    return res.status(200).json({
      status: true,
      data: {
        url,
        sitekey,
        token: result.data,
        solvedAt: new Date().toISOString(),
        duration: `${duration}ms`
      },
      creator: "RiiCODE",
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    const duration = Date.now() - startTime
    return res.status(500).json({
      status: false,
      error: error.message || 'Internal server error',
      code: 500,
      duration: `${duration}ms`,
      creator: "RiiCODE",
      timestamp: new Date().toISOString()
    })
  }
}

app.get('/', (req, res) => {
  res.json({
    status: true,
    name: 'Turnstile Solver API',
    version: '1.0.0',
    endpoints: {
      'GET /api/solver/turnstile': 'Solve Turnstile via query params',
      'POST /api/solver/turnstile': 'Solve Turnstile via JSON body',
      'GET /api/solver/turnstile/waf': 'Get WAF session',
      'GET /api/solver/turnstile/source': 'Get page HTML source',
      'GET /api/solver/stats': 'Get browser statistics',
      'GET /health': 'Health check'
    },
    creator: "RiiCODE",
    timestamp: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    browserReady: browserService.isReady(),
    stats: browserService.getBrowserStats(),
    creator: "RiiCODE",
    timestamp: new Date().toISOString()
  })
})

app.get('/api/solver/turnstile', validateTurnstileRequest('query'), handleTurnstileSolver)
app.post('/api/solver/turnstile', validateTurnstileRequest('body'), handleTurnstileSolver)

app.get('/api/solver/turnstile/waf', async (req, res) => {
  try {
    const { url } = req.query
    if (!url) {
      return res.status(400).json({ status: false, error: 'URL parameter is required', code: 400, creator: "RiiCODE" })
    }
    const result = await bypassService.wafSession(url)
    if (!result.success) {
      return res.status(500).json({ status: false, error: result.error, code: 500, creator: "RiiCODE" })
    }
    return res.status(200).json({ status: true, data: result.data, duration: `${result.duration}ms`, creator: "RiiCODE", timestamp: new Date().toISOString() })
  } catch (error) {
    return res.status(500).json({ status: false, error: error.message, code: 500, creator: "RiiCODE" })
  }
})

app.get('/api/solver/turnstile/source', async (req, res) => {
  try {
    const { url } = req.query
    if (!url) {
      return res.status(400).json({ status: false, error: 'URL parameter is required', code: 400, creator: "RiiCODE" })
    }
    const result = await bypassService.getSource(url)
    if (!result.success) {
      return res.status(500).json({ status: false, error: result.error, code: 500, creator: "RiiCODE" })
    }
    return res.status(200).json({ status: true, data: { html: result.data, url }, duration: `${result.duration}ms`, creator: "RiiCODE", timestamp: new Date().toISOString() })
  } catch (error) {
    return res.status(500).json({ status: false, error: error.message, code: 500, creator: "RiiCODE" })
  }
})

app.get('/api/solver/stats', (req, res) => {
  try {
    const stats = bypassService.getStats()
    return res.status(200).json({ status: true, data: stats, creator: "RiiCODE", timestamp: new Date().toISOString() })
  } catch (error) {
    return res.status(500).json({ status: false, error: error.message, code: 500, creator: "RiiCODE" })
  }
})

app.use((req, res) => {
  res.status(404).json({
    status: false,
    error: 'Endpoint not found',
    code: 404,
    creator: "RiiCODE",
    timestamp: new Date().toISOString()
  })
})

app.use((err, req, res, next) => {
  console.error('Global error:', err.stack)
  res.status(500).json({
    status: false,
    error: 'Internal server error',
    code: 500,
    creator: "RiiCODE",
    timestamp: new Date().toISOString()
  })
})

export default app
