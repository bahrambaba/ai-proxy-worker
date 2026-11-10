export default {
  async fetch(request, env, ctx) {
    // در صورت خطای غیرقابل‌مدیریت، پاسخ را به ازای آن به مشتری نشان نده
    if (ctx) ctx.passThroughOnException();

    const url = new URL(request.url);

    // جمع‌آوری API Keyهای NVIDIA: NV_1, NV_2, NV_3, ... (بدون محدودیت تعداد)
    const NVIDIA_KEYS = [];
    for (const [keyName, value] of Object.entries(env)) {
      if (keyName.startsWith("NV_") && value) {
        const num = parseInt(keyName.slice(3), 10);
        if (!isNaN(num)) NVIDIA_KEYS.push({ num, key: value });
      }
    }
    // مرتب‌سازی بر اساس شماره (NV_1, NV_2, ...)
    NVIDIA_KEYS.sort((a, b) => a.num - b.num);
    const nvidiaKeysOnly = NVIDIA_KEYS.map(k => k.key);

    // جمع‌آوری API Keyهای OpenRouter: OR_1, OR_2, OR_3, ... (بدون محدودیت تعداد)
    const OPENROUTER_KEYS = [];
    for (const [keyName, value] of Object.entries(env)) {
      if (keyName.startsWith("OR_") && value) {
        const num = parseInt(keyName.slice(3), 10);
        if (!isNaN(num)) OPENROUTER_KEYS.push({ num, key: value });
      }
    }
    OPENROUTER_KEYS.sort((a, b) => a.num - b.num);
    const openrouterKeysOnly = OPENROUTER_KEYS.map(k => k.key);

    const ALL_KEYS_CONFIGURED = nvidiaKeysOnly.length > 0 || openrouterKeysOnly.length > 0;
    if (!ALL_KEYS_CONFIGURED) {
      return jsonResponse({ error: "No API keys configured (need NV_* or OR_* keys)" }, 500);
    }

    // توکن اختصاصی ورکر: اگر PROXY_TOKEN تعریف شده باشد، درخواست باید همان را بفرستد.
    if (env.PROXY_TOKEN) {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.PROXY_TOKEN}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // مسیر را normalize می‌کنیم: حذف اسلش ابتدا/انتها و پیشوند v1/
    const path = url.pathname
      .replace(/\/+$/, "")
      .replace(/^\//, "")
      .replace(/^v1\//, "");

    try {
      if (path === "models") {
        return await handleModels(nvidiaKeysOnly, openrouterKeysOnly);
      }

      if (path === "chat/completions") {
        return await handleChat(request, nvidiaKeysOnly, openrouterKeysOnly);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      console.error("Worker error:", err?.message || err);
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },
};

// ====================== Constants & Helpers ======================

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5_000;

const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

const OPENROUTER_REFERER = "https://router.nova-91da07.workers.dev";
const OPENROUTER_TITLE = "OpenRouter Fallback Proxy";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

// تشخیصار Provider بر اساس نام مدل
function detectProvider(model) {
  if (!model) return null;
  
  // مدل‌های NVIDIA معمولاً پیشوند ندارند یا با nvidia/ شروع می‌شوند
  // مدل‌های OpenRouter رایگان با :free تمام می‌شوند
  if (model.endsWith(":free")) return "openrouter";
  if (model.startsWith("openrouter/") || model.includes("/") && !model.startsWith("nvidia/")) return "openrouter";
  if (model.startsWith("nvidia/")) return "nvidia";
  
  // پیش‌فرض: اگر کلید OpenRouter داریم و مدل :free نیست، هر دو را امتحان می‌کنیم
  // اما برای سادگی: مدل‌های رایگان → OpenRouter، بقیه → NVIDIA
  return model.endsWith(":free") ? "openrouter" : "nvidia";
}

// ====================== Models (ترکیبی) ======================

async function handleModels(nvidiaKeys, openrouterKeys) {
  const allModels = [];
  let nvidiaOk = false;
  let openrouterOk = false;

  // دریافت مدل‌های NVIDIA
  if (nvidiaKeys.length > 0) {
    for (let idx = 0; idx < nvidiaKeys.length; idx++) {
      try {
        const res = await fetchWithTimeout(`${NVIDIA_API_BASE}/models`, {
          headers: nvidiaHeaders(nvidiaKeys[idx]),
        });

        if (!res.ok) {
          console.log(`NVIDIA models fetch failed (${res.status}) with key ${idx + 1}, trying next...`);
          continue;
        }

        const data = await res.json();
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
        console.log("NVIDIA models fetch failed, trying next key");
        continue;
      }
    }
  }

  // دریافت مدل‌های OpenRouter (فقط رایگان)
  if (openrouterKeys.length > 0) {
    for (const key of openrouterKeys) {
      try {
        const res = await fetchWithTimeout(`${OPENROUTER_API_BASE}/models`, {
          headers: openrouterHeaders(key),
        });

        if (!res.ok) continue;

        const data = await res.json();

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
        console.log("OpenRouter models fetch failed, trying next key");
        continue;
      }
    }
  }

  if (allModels.length === 0) {
    return jsonResponse({ error: "Failed to fetch models from all keys" }, 502);
  }

  return jsonResponse({ object: "list", data: allModels });
}

// ====================== Chat Completions (مسیریابی هوشمند) ======================

async function handleChat(request, nvidiaKeys, openrouterKeys) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.model) {
    return jsonResponse(
      {
        error: {
          message: "Model is required. Specify a model in the request.",
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  const provider = detectProvider(body.model);
  const isStreaming = body.stream === true;

  // اگر مدل رایگان OpenRouter است اما کلید OpenRouter نداریم
  if (provider === "openrouter" && openrouterKeys.length === 0) {
    return jsonResponse(
      {
        error: {
          message: `Model "${body.model}" requires OpenRouter API keys (OR_*), but none are configured.`,
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  // اگر مدل NVIDIA است اما کلید NVIDIA نداریم
  if (provider === "nvidia" && nvidiaKeys.length === 0) {
    return jsonResponse(
      {
        error: {
          message: `Model "${body.model}" requires NVIDIA API keys (NV_*), but none are configured.`,
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  // اعتبارسنجی مدل‌های رایگان برای OpenRouter
  if (provider === "openrouter" && !body.model.endsWith(":free")) {
    return jsonResponse(
      {
        error: {
          message: `Only free models are allowed on OpenRouter. "${body.model}" is not free.`,
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  // انتخاب کلیدها بر اساس پروفایدر
  const keys = provider === "openrouter" ? openrouterKeys : nvidiaKeys;
  const apiBase = provider === "openrouter" ? OPENROUTER_API_BASE : NVIDIA_API_BASE;
  const headersFn = provider === "openrouter" ? openrouterHeaders : nvidiaHeaders;
  const endpoint = "/chat/completions";

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
          return new Response(response.body, {
            headers: {
              ...corsHeaders(),
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        } else {
          const data = await response.json();
          return jsonResponse(data);
        }
      }

      const errorText = await response.text();
      lastErrorText = errorText;

      if (isRateLimitOrOverload(response.status, errorText)) {
        console.log(`${provider.toUpperCase()} Key ${keyIndex + 1} limited/overloaded (${response.status}), trying next...`);
        if (i < keys.length - 1) {
          const retryAfter = parseFloat(response.headers.get("retry-after") || "0");
          const delay =
            retryAfter > 0
              ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
              : 300 + Math.random() * 400;
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
      return new Response(errorText, {
        status: response.status,
        headers: {
          ...corsHeaders(),
          "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8",
        },
      });
    } catch (err) {
      console.log(`${provider.toUpperCase()} Key ${keyIndex + 1} network error`, err?.name || err?.message);
      lastErrorText = err?.message || String(err);
      if (i < keys.length - 1) {
        await sleep(200);
      }
      continue;
    }
  }

  return jsonResponse(
    {
      error: {
        message: `All ${provider.toUpperCase()} API keys (${provider === "openrouter" ? "OR_*" : "NV_*"}) are currently rate-limited or unavailable. Please try again in a few minutes.`,
        type: "rate_limit_exceeded",
        details: extractErrorMessage(lastErrorText).slice(0, 300),
      },
    },
    429
  );
}

// ====================== Header Builders ======================

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