import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ====================== Constants & Helpers ======================

const FETCH_TIMEOUT_MS = 30_000;
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

// تشخیص Provider بر اساس نام مدل
function detectProvider(model) {
  if (!model) return null;

  if (model.endsWith(":free")) return "openrouter";
  if (model.startsWith("openrouter/") || (model.includes("/") && !model.startsWith("nvidia/")))
    return "openrouter";
  if (model.startsWith("nvidia/")) return "nvidia";

  return model.endsWith(":free") ? "openrouter" : "nvidia";
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

// ====================== Routes ======================

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// List models
app.get("/models", async (req, res) => {
  try {
    const { nvidia, openrouter } = getApiKeys(process.env);
    const allModels = [];
    let nvidiaOk = false;
    let openrouterOk = false;

    // Fetch NVIDIA models
    if (nvidia.length > 0) {
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
});

// Chat completions
app.post("/chat/completions", async (req, res) => {
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
    const provider = detectProvider(body.model);
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

    // Randomize start index to distribute load
    const startIndex = Math.floor(Math.random() * keys.length);
    let lastErrorText = "";

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
            // Set SSE headers
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

            // Pipe the stream
            response.body.pipe(res);
            return;
          } else {
            const data = await response.json();
            return res.json(data);
          }
        }

        const errorText = await response.text();
        lastErrorText = errorText;

        if (isRateLimitOrOverload(response.status, errorText)) {
          console.log(`${provider.toUpperCase()} Key ${keyIndex + 1} limited/overloaded (${response.status}), trying next...`);
          if (i < keys.length - 1) {
            const retryAfter = parseFloat(response.headers.get("retry-after") || "0");
            const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 300 + Math.random() * 400;
            await sleep(delay);
          }
          continue;
        }

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
        if (i < keys.length - 1) {
          await sleep(200);
        }
        continue;
      }
    }

    return res.status(429).json({
      error: {
        message: `All ${provider.toUpperCase()} API keys (${provider === "openrouter" ? "OR_*" : "NV_*"}) are currently rate-limited or unavailable. Please try again in a few minutes.`,
        type: "rate_limit_exceeded",
        details: extractErrorMessage(lastErrorText).slice(0, 300),
      },
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// CORS preflight
app.options("/*", (req, res) => {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.sendStatus(204);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ====================== Start Server ======================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 AI Proxy Worker running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /models`);
  console.log(`   POST /chat/completions`);
  console.log(`\n🔑 Configured keys:`);
  const { nvidia, openrouter } = getApiKeys(process.env);
  console.log(`   NVIDIA: ${nvidia.length} key(s)`);
  console.log(`   OpenRouter: ${openrouter.length} key(s)`);
  if (process.env.PROXY_TOKEN) {
    console.log(`   PROXY_TOKEN: ✓ configured`);
  }
});