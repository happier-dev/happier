import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.HAPPIER_TEST_CATALOG_START_FILE) appendFileSync(process.env.HAPPIER_TEST_CATALOG_START_FILE, `${process.pid}\n`);
if (process.env.HAPPIER_TEST_CATALOG_ENV_FILE) writeFileSync(process.env.HAPPIER_TEST_CATALOG_ENV_FILE, JSON.stringify({ HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR }));
if (process.env.HAPPIER_TEST_CATALOG_SHUTDOWN_DELAY_MS) {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), Number(process.env.HAPPIER_TEST_CATALOG_SHUTDOWN_DELAY_MS)));
}

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
  if (process.env.HAPPIER_TEST_CONTROL_PROCESS_CAPTURE_FILE) {
    writeFileSync(process.env.HAPPIER_TEST_CONTROL_PROCESS_CAPTURE_FILE, JSON.stringify({
      cwd: process.cwd(),
      rpcTimeoutMs: Number(process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS),
    }));
  }
  if (process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE) {
    writeFileSync(process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE, JSON.stringify({
      CODEX_HOME: process.env.CODEX_HOME ?? null,
      CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME ?? null,
      HAPPIER_FAKE_PROFILE_MARKER: process.env.HAPPIER_FAKE_PROFILE_MARKER ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      CODEX_AUTH_FILE_PRESENT: typeof process.env.CODEX_HOME === 'string'
        ? existsSync(join(process.env.CODEX_HOME, 'auth.json'))
        : false,
    }));
  }
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

  if (method === 'skills/list' && msg.id !== undefined) {
    const respond = () => write({ id: msg.id, result: { data: [{ cwd: msg.params.cwds[0], skills: [{
      name: 'review', path: `${msg.params.cwds[0]}/SKILL.md`, description: 'Review code', enabled: true,
    }], errors: [] }] } });
    const catalogDelayMs = Number(process.env.HAPPIER_TEST_CATALOG_DELAY_MS ?? 0);
    if (catalogDelayMs > 0) setTimeout(respond, catalogDelayMs);
    else respond();
    return;
  }

  if (method === 'initialize' && msg.id !== undefined) {
    handleInitialize(msg);
    return;
  }

  if (method === 'model/list' && msg.id !== undefined) {
    handleModelList(msg);
    return;
  }

  if (method === 'config/read' && msg.id !== undefined && process.env.HAPPIER_TEST_CONFIGURED_MODEL) {
    write({ id: msg.id, result: { config: { model: process.env.HAPPIER_TEST_CONFIGURED_MODEL } } });
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
