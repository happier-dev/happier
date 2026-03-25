import readline from 'node:readline';

const delayMs = Number.parseInt(process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS ?? '', 10) || 600;

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handleInitialize(msg) {
  write({
    id: msg.id,
    result: {
      userAgent: 'fake/0.0.0',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });
}

function handleModelList(msg) {
  setTimeout(() => {
    write({
      id: msg.id,
      result: {
        data: [
          {
            id: 'gpt-5.4',
            displayName: 'gpt-5.4',
            description: 'Latest frontier agentic coding model.',
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Low' },
              { reasoningEffort: 'medium', description: 'Medium' },
              { reasoningEffort: 'high', description: 'High' },
            ],
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: null,
      },
    });
  }, delayMs);
}

function handleCollaborationModeList(msg) {
  write({
    id: msg.id,
    result: {
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
        { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
      ],
    },
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const raw = String(line ?? '').trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  const method = msg.method;
  if (method === 'initialized') return;

  if (method === 'initialize' && msg.id !== undefined) {
    handleInitialize(msg);
    return;
  }

  if (method === 'model/list' && msg.id !== undefined) {
    handleModelList(msg);
    return;
  }

  if (method === 'collaborationMode/list' && msg.id !== undefined) {
    handleCollaborationModeList(msg);
    return;
  }

  if (msg.id !== undefined) {
    write({ id: msg.id, error: { code: -32601, message: `Method not found: ${String(method ?? '')}` } });
  }
});
