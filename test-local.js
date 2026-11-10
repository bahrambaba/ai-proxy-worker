# Test script for local development
# Usage: node test-local.js

import "dotenv/config";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PROXY_TOKEN = process.env.PROXY_TOKEN;

async function test() {
  console.log("🧪 Testing AI Proxy Worker locally...\n");

  // Test 1: Health check
  try {
    const health = await fetch(`${BASE_URL}/health`);
    const data = await health.json();
    console.log("✅ Health check:", data);
  } catch (e) {
    console.error("❌ Health check failed:", e.message);
    return;
  }

  // Test 2: List models
  try {
    const models = await fetch(`${BASE_URL}/models`);
    const data = await models.json();
    console.log(`✅ Models: Found ${data.data?.length || 0} models`);
    if (data.data?.length) {
      console.log("   Sample:", data.data.slice(0, 3).map(m => m.id).join(", "));
    }
  } catch (e) {
    console.error("❌ Models failed:", e.message);
  }

  // Test 3: Chat completion (non-streaming)
  try {
    const headers = { "Content-Type": "application/json" };
    if (PROXY_TOKEN) headers["Authorization"] = `Bearer ${PROXY_TOKEN}`;

    const chat = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct:free",
        messages: [{ role: "user", content: "Say hello in one word" }],
        temperature: 0.7,
      }),
    });
    const data = await chat.json();
    if (chat.ok) {
      console.log("✅ Chat completion:", data.choices?.[0]?.message?.content?.slice(0, 50) || "OK");
    } else {
      console.log("⚠️ Chat completion error (expected if no keys):", data.error?.message);
    }
  } catch (e) {
    console.error("❌ Chat completion failed:", e.message);
  }

  console.log("\n🏁 Tests complete");
}

test();