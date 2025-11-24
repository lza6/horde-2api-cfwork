// =================================================================================
//  项目: horde-2api (Cloudflare Worker 单文件版)
//  版本: 3.5.0 (代号: Chimera Synthesis - Horde Edition)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版
//  日期: 2025-11-24
//
//  描述:
//  将去中心化算力网络 AI Horde (aihorde.net) 封装为高性能、OpenAI 兼容的 API。
//  支持文本生成 (Chat) 和图像生成 (Image)，内置自动异步轮询机制。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "AI Horde Bridge",
  PROJECT_VERSION: "3.5.0",

  // [安全配置]
  // 这是连接此 Worker 的密码，在 Cherry Studio 中填写此值
  API_MASTER_KEY: "1", 

  // [上游配置]
  UPSTREAM_API_URL: "https://aihorde.net/api/v2",
  
  // [负载均衡密钥池]
  // 系统会自动在这些密钥中轮询使用
  HORDE_API_KEYS: [
    "urmqv7kzdenTmQXnwo5YxQ", // 您的私有密钥 (优先级高)
    "0000000000"              // 匿名密钥 (备用，速度较慢)
  ],

  // [模型列表]
  // 基于您提供的数据预设的文本模型
  TEXT_MODELS: [
    "koboldcpp/L3-8B-Stheno-v3.2",
    "koboldcpp/Llama-3-Lumimaid-8B-v0.1",
    "koboldcpp/Lumimaid-v0.2-8B",
    "koboldcpp/mini-magnum-12b-v1.1",
    "koboldcpp/Mistral-7B-Instruct-v0.3.Q4_K_M",
    "koboldcpp/Qwen3-30B-A3B-Instruct-2507",
    "aphrodite/ReadyArt/Dark-Nexus-12B-v2.0",
    "aphrodite/TheDrummer/Precog-123B-v1-nvfp4"
  ],
  
  // 图像模型 (示例)
  IMAGE_MODELS: [
    "AlbedoBase XL (SDXL)",
    "stable_diffusion"
  ],

  DEFAULT_MODEL: "koboldcpp/L3-8B-Stheno-v3.2",
  
  // [轮询配置]
  POLL_INTERVAL: 3000, // 每次检查间隔 (毫秒)
  TIMEOUT_MS: 180000   // 最大超时时间 (3分钟)
};

// 简单的轮询计数器
let keyIndex = 0;

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request);
    } 
    
    // 3. API 路由
    if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    }

    // 4. 404
    return createErrorResponse(`未找到路径: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * API 路由分发
 */
async function handleApi(request) {
  // 1. 鉴权 (验证连接此 Worker 的密码)
  const authHeader = request.headers.get('Authorization');
  if (CONFIG.API_MASTER_KEY && CONFIG.API_MASTER_KEY !== "") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证 (请填写 API Key)', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== CONFIG.API_MASTER_KEY) {
      return createErrorResponse('无效的 API Key', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  // 2. 路由分发
  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  } else {
    return createErrorResponse(`不支持的端点: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * 获取 Horde 密钥 (负载均衡)
 */
function getHordeKey() {
  const key = CONFIG.HORDE_API_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % CONFIG.HORDE_API_KEYS.length;
  return key;
}

/**
 * 处理 /v1/models
 */
function handleModelsRequest() {
  const allModels = [...CONFIG.TEXT_MODELS, ...CONFIG.IMAGE_MODELS];
  const modelsData = {
    object: 'list',
    data: allModels.map(id => ({
      id: id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'ai-horde',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

/**
 * 核心：处理文本生成 (Chat Completions)
 * 逻辑：OpenAI 格式 -> Horde 格式 -> 提交任务 -> 轮询状态 -> 返回 OpenAI 格式
 */
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    
    // 简单地将所有消息拼接为 Prompt (Horde 是 Text Completion 接口)
    // 更好的做法是应用 Chat Template，这里做简化处理
    let prompt = "";
    messages.forEach(m => {
      prompt += `${m.role}: ${m.content}\n`;
    });
    prompt += "assistant: ";

    const model = body.model || CONFIG.DEFAULT_MODEL;
    const hordeKey = getHordeKey();

    // 1. 提交任务
    const submitPayload = {
      prompt: prompt,
      params: {
        n: 1,
        max_context_length: 2048,
        max_length: 512, // 生成长度
        temperature: body.temperature || 0.7,
        top_p: body.top_p || 0.9,
      },
      models: [model],
      trusted_workers: false,
      nsfw: true,
      shared: true,
      priority: 10
    };

    const submitRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/generate/text/async`, {
      method: 'POST',
      headers: {
        'apikey': hordeKey,
        'Content-Type': 'application/json',
        'Client-Agent': 'Chimera-Worker:v1.0'
      },
      body: JSON.stringify(submitPayload)
    });

    const submitData = await submitRes.json();
    if (!submitData.id) {
      throw new Error(submitData.message || "Horde 任务提交失败");
    }
    const taskId = submitData.id;

    // 2. 轮询等待结果 (Server-Side Polling)
    let resultText = "";
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > CONFIG.TIMEOUT_MS) throw new Error("生成超时");

      // 等待
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL));

      const statusRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/generate/text/status/${taskId}`, {
        headers: { 'Client-Agent': 'Chimera-Worker:v1.0' }
      });
      const statusData = await statusRes.json();

      if (statusData.finished === 1) {
        if (statusData.generations && statusData.generations.length > 0) {
          resultText = statusData.generations[0].text;
        }
        break; // 完成
      } else if (statusData.faulted) {
        throw new Error("Horde Worker 报错");
      }
      // 继续轮询...
    }

    // 3. 构造 OpenAI 响应
    // 如果客户端请求流式 (stream: true)，我们需要伪造一个流
    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        // 发送内容
        const chunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        
        // 发送结束
        const endChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();

      return new Response(readable, {
        headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
      });

    } else {
      // 普通 JSON 响应
      const response = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: resultText },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      return new Response(JSON.stringify(response), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

/**
 * 处理图像生成 (Images Generations)
 */
async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    const model = "AlbedoBase XL (SDXL)"; // 强制使用一个通用模型，或者从 body.model 获取
    const hordeKey = getHordeKey();

    // 1. 提交
    const submitPayload = {
      prompt: prompt,
      params: {
        steps: 20,
        n: 1,
        width: 1024,
        height: 1024,
        sampler_name: "k_euler_a"
      },
      nsfw: true,
      censor_nsfw: false,
      trusted_workers: false,
      models: [model],
      r2: true // 使用 R2 存储，返回 URL
    };

    const submitRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/generate/async`, {
      method: 'POST',
      headers: {
        'apikey': hordeKey,
        'Content-Type': 'application/json',
        'Client-Agent': 'Chimera-Worker:v1.0'
      },
      body: JSON.stringify(submitPayload)
    });
    const submitData = await submitRes.json();
    if (!submitData.id) throw new Error("图片任务提交失败");
    const taskId = submitData.id;

    // 2. 轮询
    let imageUrl = "";
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > CONFIG.TIMEOUT_MS) throw new Error("生成超时");
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL));

      const checkRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/generate/check/${taskId}`);
      const checkData = await checkRes.json();

      if (checkData.done) {
        // 获取最终结果
        const statusRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/generate/status/${taskId}`);
        const statusData = await statusRes.json();
        if (statusData.generations && statusData.generations.length > 0) {
          imageUrl = statusData.generations[0].img;
        }
        break;
      }
    }

    // 3. 返回 OpenAI 格式
    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: imageUrl }]
    }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'image_gen_failed');
  }
}

// --- 辅助函数 ---
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; }
      body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; display: flex; height: 100vh; }
      .sidebar { width: 350px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; }
      .main { flex: 1; padding: 20px; display: flex; flex-direction: column; }
      .box { background: #252525; padding: 15px; border-radius: 8px; margin-bottom: 15px; border: 1px solid var(--border); }
      .label { font-size: 12px; color: #888; display: block; margin-bottom: 5px; }
      .code { background: #000; padding: 8px; border-radius: 4px; font-family: monospace; color: var(--primary); word-break: break-all; cursor: pointer; }
      input, textarea, select { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; box-sizing: border-box; margin-bottom: 10px; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
      button:disabled { background: #555; }
      .chat-box { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 15px; overflow-y: auto; margin-bottom: 15px; }
      .msg { margin-bottom: 10px; padding: 8px 12px; border-radius: 6px; max-width: 80%; }
      .msg.user { background: #333; align-self: flex-end; margin-left: auto; }
      .msg.ai { background: #1a1a1a; border: 1px solid #333; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>⚡ ${CONFIG.PROJECT_NAME}</h2>
        <div class="box">
            <span class="label">API Endpoint (Base URL)</span>
            <div class="code" onclick="copy('${origin}/v1')">${origin}/v1</div>
        </div>
        <div class="box">
            <span class="label">API Key (Password)</span>
            <div class="code" onclick="copy('${CONFIG.API_MASTER_KEY}')">${CONFIG.API_MASTER_KEY}</div>
        </div>
        <div class="box">
            <span class="label">选择模型</span>
            <select id="model">
                ${CONFIG.TEXT_MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            <span class="label">测试提示词</span>
            <textarea id="prompt" rows="4">Hello, who are you?</textarea>
            <button id="btn" onclick="send()">发送测试请求</button>
        </div>
        <div style="font-size:12px; color:#666; margin-top:auto;">
            状态: <span id="status" style="color:#66BB6A">● 系统就绪</span>
        </div>
    </div>
    <div class="main">
        <div class="chat-box" id="chat">
            <div style="text-align:center; color:#666; margin-top:50px;">
                在此处测试 AI Horde 的文本生成能力。<br>
                Worker 会自动处理异步轮询。
            </div>
        </div>
    </div>
    <script>
        function copy(t) { navigator.clipboard.writeText(t); alert('已复制'); }
        
        async function send() {
            const p = document.getElementById('prompt').value;
            const m = document.getElementById('model').value;
            const btn = document.getElementById('btn');
            const chat = document.getElementById('chat');
            
            if(!p) return;
            
            btn.disabled = true;
            btn.innerText = "生成中 (请耐心等待)...";
            
            // User Msg
            chat.innerHTML += \`<div class="msg user">\${p}</div>\`;
            
            try {
                const res = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ${CONFIG.API_MASTER_KEY}'
                    },
                    body: JSON.stringify({
                        model: m,
                        messages: [{role: "user", content: p}],
                        stream: false // 简单起见，测试用非流式
                    })
                });
                
                const data = await res.json();
                if(data.error) throw new Error(data.error.message);
                
                const reply = data.choices[0].message.content;
                chat.innerHTML += \`<div class="msg ai">\${reply}</div>\`;
                
            } catch(e) {
                chat.innerHTML += \`<div class="msg ai" style="color:#ff5555">错误: \${e.message}</div>\`;
            } finally {
                btn.disabled = false;
                btn.innerText = "发送测试请求";
                chat.scrollTop = chat.scrollHeight;
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
