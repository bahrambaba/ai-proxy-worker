import express from "express";
import cors from "cors";
import { Readable } from "node:stream";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
// alwaysdata requires the server to listen on IPv6 (::).
// It provides the address in the IP env var; fall back to :: in production.
const HOST = process.env.IP || "::";

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ====================== Auth Middleware ======================
// If PROXY_TOKEN is set, every request (except health & preflight) must
// send: Authorization: Bearer <PROXY_TOKEN>
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (req.path === "/health" || req.path === "/v1/health") return next();
  if (!process.env.PROXY_TOKEN) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${process.env.PROXY_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ====================== Constants & Helpers ======================

const FETCH_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "30000", 10);
const MAX_RETRY_AFTER_MS = 5_000;

const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

// Default referer/title for OpenRouter (can be overridden via env)
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || "https://ai-proxy.alwaysdata.net";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || "AI Proxy Worker";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Pipe an upstream Web ReadableStream to the Express response, with error handling.
function pipeUpstreamStream(res, response) {
  if (!response.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.on("error", (e) => {
    console.error("Stream error:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "Stream error" });
    else res.end();
  });
  nodeStream.pipe(res);
}

function isRateLimitOrOverload(status, errorText = "") {
  if ([429, 402, 503, 529].includes(status)) return true;

  const text = errorText.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate-limit") ||
    text.includes("too many requests") ||
    text.includes("overloaded") ||
    text.includes("capacity") ||
    text.includes("temporarily unavailable") ||
    text.includes("quota exceeded") ||
    text.includes("service unavailable") ||
    text.includes("no endpoints found")
  );
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || text;
  } catch {
    return text;
  }
}

// Header builders
function nvidiaHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function openrouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": OPENROUTER_REFERER,
    "X-Title": OPENROUTER_TITLE,
  };
}

// ====================== API Key Management ======================

// Cache for NVIDIA model IDs (populated on first /models call)
let nvidiaModelCache = new Set();
let nvidiaModelCacheTime = 0;
const NVIDIA_MODEL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getApiKeys(env) {
  const nvidiaKeys = [];
  const openrouterKeys = [];

  for (const [keyName, value] of Object.entries(env)) {
    if (keyName.startsWith("NV_") && value) {
      const num = parseInt(keyName.slice(3), 10);
      if (!isNaN(num)) nvidiaKeys.push({ num, key: value });
    }
    if (keyName.startsWith("OR_") && value) {
      const num = parseInt(keyName.slice(3), 10);
      if (!isNaN(num)) openrouterKeys.push({ num, key: value });
    }
  }

  nvidiaKeys.sort((a, b) => a.num - b.num);
  openrouterKeys.sort((a, b) => a.num - b.num);

  return {
    nvidia: nvidiaKeys.map((k) => k.key),
    openrouter: openrouterKeys.map((k) => k.key),
  };
}

// Refresh NVIDIA model cache
async function refreshNvidiaModelCache(nvidiaKeys) {
  const now = Date.now();
  if (nvidiaModelCache.size > 0 && (now - nvidiaModelCacheTime) < NVIDIA_MODEL_CACHE_TTL) {
    return; // cache still valid
  }

  if (nvidiaKeys.length === 0) return;

  for (let idx = 0; idx < nvidiaKeys.length; idx++) {
    try {
      const response = await fetchWithTimeout(`${NVIDIA_API_BASE}/models`, {
        headers: nvidiaHeaders(nvidiaKeys[idx]),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const models = (data.data || []).map((m) => m.id);
      
      nvidiaModelCache = new Set(models);
      nvidiaModelCacheTime = now;
      console.log(`NVIDIA model cache refreshed: ${nvidiaModelCache.size} models`);
      break;
    } catch (e) {
      console.log("NVIDIA model cache refresh failed, trying next key:", e.message);
      continue;
    }
  }
}

// تشخیص Provider بر اساس نام مدل
async function detectProvider(model) {
  if (!model) return null;

  // اگر مدل در کش NVIDIA نیست، کش را (در صورت خالی/کهنه بودن) رفرش کن
  if (!nvidiaModelCache.has(model)) {
    const { nvidia } = getApiKeys(process.env);
    await refreshNvidiaModelCache(nvidia);
  }

  // مدل‌های NVIDIA (از کش مدل‌های موجود در NVIDIA API)
  if (nvidiaModelCache.has(model)) return "nvidia";

  // مدل‌های OpenRouter رایگان با :free تمام می‌شوند
  if (model.endsWith(":free")) return "openrouter";
  if (model.startsWith("openrouter/")) return "openrouter";

  // پیش‌فرض: NVIDIA
  return "nvidia";
}

// ====================== Routes ======================

// Health check (both paths)
app.get(["/health", "/v1/health"], (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// List models handler
const modelsHandler = async (req, res) => {
  try {
    const { nvidia, openrouter } = getApiKeys(process.env);
    const allModels = [];
    let nvidiaOk = false;
    let openrouterOk = false;

    // Fetch NVIDIA models
    if (nvidia.length > 0) {
      // Refresh NVIDIA model cache
      await refreshNvidiaModelCache(nvidia);

      for (let idx = 0; idx < nvidia.length; idx++) {
        try {
          const response = await fetchWithTimeout(`${NVIDIA_API_BASE}/models`, {
            headers: nvidiaHeaders(nvidia[idx]),
          });

          if (!response.ok) {
            console.log(`NVIDIA models fetch failed (${response.status}) with key ${idx + 1}, trying next...`);
            continue;
          }

          const data = await response.json();
          const models = (data.data || []).map((m) => ({
            id: m.id,
            object: "model",
            created: m.created ?? Math.floor(Date.now() / 1000),
            owned_by: m.owned_by || "nvidia",
            provider: "nvidia",
          }));
          allModels.push(...models);
          nvidiaOk = true;
          break;
        } catch (e) {
          console.log("NVIDIA models fetch failed, trying next key:", e.message);
          continue;
        }
      }
    }

    // Fetch OpenRouter models (free only)
    if (openrouter.length > 0) {
      for (const key of openrouter) {
        try {
          const response = await fetchWithTimeout(`${OPENROUTER_API_BASE}/models`, {
            headers: openrouterHeaders(key),
          });

          if (!response.ok) continue;

          const data = await response.json();

          const freeModels = data.data
            .filter((m) => m.id && m.id.endsWith(":free"))
            .map((m) => ({
              id: m.id,
              object: "model",
              created: m.created ?? Math.floor(Date.now() / 1000),
              owned_by: m.id.split("/")[0] || "openrouter",
              provider: "openrouter",
            }));

          allModels.push(...freeModels);
          openrouterOk = true;
          break;
        } catch (e) {
          console.log("OpenRouter models fetch failed, trying next key:", e.message);
          continue;
        }
      }
    }

    if (allModels.length === 0) {
      return res.status(502).json({ error: "Failed to fetch models from all keys" });
    }

    res.json({ object: "list", data: allModels });
  } catch (err) {
    console.error("Models error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Register models routes for both paths
app.get(["/models", "/v1/models"], modelsHandler);

// Chat completions handler
const chatHandler = async (req, res) => {
  try {
    const body = req.body;

    if (!body.model) {
      return res.status(400).json({
        error: {
          message: "Model is required. Specify a model in the request.",
          type: "invalid_request_error",
        },
      });
    }

    const { nvidia, openrouter } = getApiKeys(process.env);
    const provider = await detectProvider(body.model);
    const isStreaming = body.stream === true;

    // Check if required keys exist
    if (provider === "openrouter" && openrouter.length === 0) {
      return res.status(400).json({
        error: {
          message: `Model "${body.model}" requires OpenRouter API keys (OR_*), but none are configured.`,
          type: "invalid_request_error",
        },
      });
    }

    if (provider === "nvidia" && nvidia.length === 0) {
      return res.status(400).json({
        error: {
          message: `Model "${body.model}" requires NVIDIA API keys (NV_*), but none are configured.`,
          type: "invalid_request_error",
        },
      });
    }

    // Validate free models for OpenRouter
    if (provider === "openrouter" && !body.model.endsWith(":free")) {
      return res.status(400).json({
        error: {
          message: `Only free models are allowed on OpenRouter. "${body.model}" is not free.`,
          type: "invalid_request_error",
        },
      });
    }

    const keys = provider === "openrouter" ? openrouter : nvidia;
    const apiBase = provider === "openrouter" ? OPENROUTER_API_BASE : NVIDIA_API_BASE;
    const headersFn = provider === "openrouter" ? openrouterHeaders : nvidiaHeaders;
    const endpoint = "/chat/completions";

    const startIndex = Math.floor(Math.random() * keys.length);
    let lastErrorText = "";
    let sawTimeout = false;
    let lastStatus = 0;

    for (let i = 0; i < keys.length; i++) {
      const keyIndex = (startIndex + i) % keys.length;
      const apiKey = keys[keyIndex];

      try {
        const response = await fetchWithTimeout(`${apiBase}${endpoint}`, {
          method: "POST",
          headers: headersFn(apiKey),
          body: JSON.stringify(body),
        });

        if (response.ok) {
          if (isStreaming) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
            pipeUpstreamStream(res, response);
          } else {
            const data = await response.json();
            res.json(data);
          }
          return;
        }

        const errorText = await response.text();
        lastErrorText = errorText;
        lastStatus = response.status;

        if (isRateLimitOrOverload(response.status, errorText)) {
          console.log(`${provider.toUpperCase()} Key ${keyIndex + 1} limited/overloaded (${response.status}), trying next...`);
          if (i < keys.length - 1) {
            const retryAfter = parseFloat(response.headers.get("retry-after") || "0");
            const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 300 + Math.random() * 400;
            await sleep(delay);
          }
          continue;
        }

        // Non-retryable error (400/401/403/404...): return it directly
        let isJson = true;
        try {
          JSON.parse(errorText);
        } catch {
          isJson = false;
        }
        return res.status(response.status).type(isJson ? "application/json" : "text/plain; charset=utf-8").send(errorText);
      } catch (err) {
        console.log(`${provider.toUpperCase()} Key ${keyIndex + 1} network error:`, err.name || err.message);
        lastErrorText = err.message || String(err);
        if (err.name === "AbortError" || err.name === "TimeoutError") sawTimeout = true;
        if (i < keys.length - 1) {
          await sleep(200);
        }
        continue;
      }
    }

    // ---- Fallback: if NVIDIA failed, try the OpenRouter ":free" twin ----
    if (provider === "nvidia" && openrouter.length > 0 && !body.model.endsWith(":free")) {
      const fbModel = `${body.model}:free`;
      const fbBody = { ...body, model: fbModel };
      const fbStart = Math.floor(Math.random() * openrouter.length);

      for (let i = 0; i < openrouter.length; i++) {
        const key = openrouter[(fbStart + i) % openrouter.length];
        try {
          const response = await fetchWithTimeout(`${OPENROUTER_API_BASE}/chat/completions`, {
            method: "POST",
            headers: openrouterHeaders(key),
            body: JSON.stringify(fbBody),
          });

          if (response.ok) {
            console.log(`Fell back to OpenRouter free model: ${fbModel}`);
            res.setHeader("X-Fallback-Provider", "openrouter");
            res.setHeader("X-Fallback-Model", fbModel);
            if (isStreaming) {
              res.setHeader("Content-Type", "text/event-stream");
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("Connection", "keep-alive");
              Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
              pipeUpstreamStream(res, response);
            } else {
              const data = await response.json();
              res.json(data);
            }
            return;
          }
          lastErrorText = await response.text();
          lastStatus = response.status;
        } catch (err) {
          lastErrorText = err.message || String(err);
          if (err.name === "AbortError" || err.name === "TimeoutError") sawTimeout = true;
          continue;
        }
      }
    }

    const providerLabel = provider === "openrouter" ? "OR_*" : "NV_*";
    const timedOut = sawTimeout && ![429, 402, 503, 529].includes(lastStatus);

    return res.status(timedOut ? 504 : 429).json({
      error: {
        message: timedOut
          ? `${provider.toUpperCase()} upstream timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s (key(s): ${providerLabel}). The model may be cold-starting or overloaded. Try a smaller model, or raise UPSTREAM_TIMEOUT_MS.`
          : `All ${provider.toUpperCase()} API keys (${providerLabel}) are currently rate-limited or unavailable. Please try again in a few minutes.`,
        type: timedOut ? "upstream_timeout" : "rate_limit_exceeded",
        details: extractErrorMessage(lastErrorText).slice(0, 300),
      },
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Register chat routes for both paths
app.post(["/chat/completions", "/v1/chat/completions"], chatHandler);

// CORS preflight (both paths)
app.options(["/*", "/v1/*"], (req, res) => {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.sendStatus(204);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message || err);
  // Preserve body-parser/client error statuses (e.g. 400 for invalid JSON)
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Internal Server Error";
  res.status(status).json({ error: message });
});

// ====================== Start Server ======================

app.listen(PORT, HOST, () => {
  console.log(`🚀 AI Proxy Worker running on http://[${HOST}]:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health, /v1/health`);
  console.log(`   GET  /models, /v1/models`);
  console.log(`   POST /chat/completions, /v1/chat/completions`);
  console.log(`\n🔑 Configured keys:`);
  const { nvidia, openrouter } = getApiKeys(process.env);
  console.log(`   NVIDIA: ${nvidia.length} key(s)`);
  console.log(`   OpenRouter: ${openrouter.length} key(s)`);
  if (process.env.PROXY_TOKEN) {
    console.log(`   PROXY_TOKEN: ✓ configured`);
  }
});