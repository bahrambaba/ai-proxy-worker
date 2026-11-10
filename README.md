# AI Proxy Worker

A Cloudflare Worker that acts as a unified proxy for **NVIDIA API** and **OpenRouter** (free models only), with automatic failover across multiple API keys.

## Features

- 🔀 **Smart Routing**: Automatically routes requests to NVIDIA or OpenRouter based on model name
- 🔑 **Multi-Key Failover**: Supports unlimited API keys (NV-1, NV-2... / OR-1, OR-2...)
- 🔄 **Automatic Retry**: On rate limits (429, 503, 529) or network errors, tries next key
- 📡 **Streaming Support**: Full Server-Sent Events (SSE) streaming for chat completions
- 🛡️ **Optional Auth**: Protect your worker with a custom `PROXY_TOKEN`
- 🌐 **CORS Enabled**: Ready for browser-based clients
- ⚡ **Edge Deployment**: Runs on Cloudflare's global network

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models` | List all available models from both providers |
| `POST` | `/chat/completions` | Chat completions (OpenAI-compatible) |
| `OPTIONS` | `/*` | CORS preflight |

## Model Routing Logic

| Model Pattern | Provider |
|---------------|----------|
| `*:free` (e.g., `meta-llama/llama-3.1-8b-instruct:free`) | OpenRouter |
| `nvidia/*` (e.g., `nvidia/nemotron-3-ultra`) | NVIDIA |
| `openrouter/*` | OpenRouter |
| `*/*` (contains `/` but not `nvidia/`) | OpenRouter |
| Otherwise | NVIDIA (default) |

> ⚠️ **Only free OpenRouter models** (`:free` suffix) are supported.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Secrets
```bash
# NVIDIA API Keys (at least one required if using NVIDIA models)
wrangler secret put NV-1
wrangler secret put NV-2

# OpenRouter API Keys (at least one required if using OpenRouter models)
wrangler secret put OR-1
wrangler secret put OR-2

# Optional: Protect your worker endpoint
wrangler secret put PROXY_TOKEN
```

### 3. Develop Locally
```bash
npm run dev
```

### 4. Deploy
```bash
npm run deploy
```

## Usage Examples

### List Models
```bash
curl https://your-worker.your-subdomain.workers.dev/models
```

### Chat Completion (Non-streaming)
```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_TOKEN" \
  -d '{
    "model": "meta-llama/llama-3.1-8b-instruct:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "temperature": 0.7
  }'
```

### Chat Completion (Streaming)
```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_TOKEN" \
  -d '{
    "model": "nvidia/nemotron-3-ultra",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

### With NVIDIA Model
```json
{
  "model": "nvidia/nemotron-3-ultra",
  "messages": [{"role": "user", "content": "Explain quantum computing"}]
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NV-1`, `NV-2`, ... | At least one group | NVIDIA API keys from [integrate.api.nvidia.com](https://integrate.api.nvidia.com) |
| `OR-1`, `OR-2`, ... | At least one group | OpenRouter API keys from [openrouter.ai](https://openrouter.ai/keys) |
| `PROXY_TOKEN` | No | Custom bearer token for worker authentication |

## How Failover Works

1. Keys are shuffled randomly at start (prevents thundering herd)
2. Requests try each key in order until success
3. On **rate limit** (429, 402, 503, 529) or **network error**:
   - Waits `retry-after` header (max 5s) or random 300-700ms
   - Tries next key
4. On **other errors** (400, 401, 404...): Returns immediately
5. If **all keys exhausted**: Returns `429` with details

## Project Structure

```
ai-proxy-worker/
├── src/
│   └── index.js          # Main worker code
├── wrangler.toml         # Cloudflare Worker config
├── package.json          # NPM scripts & dependencies
└── README.md             # This file
```

## Development

### Local Testing with `.dev.vars`
Create a `.dev.vars` file (not committed):
```bash
NV-1="your-test-key"
OR-1="your-test-key"
PROXY_TOKEN="test-token"
```

Then run:
```bash
npm run dev
```

### View Logs
```bash
npm run tail
```

## License

MIT © [Bahram Babaei](https://github.com/bahrambaba)