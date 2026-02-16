import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

function createFakeClaudeEntrypointSource(): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');

const logPath = process.env.FAKE_CLAUDE_LOG_PATH || '';
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

const toolName = process.env.FAKE_CLAUDE_TOOL_NAME || '';
const hangTurn = process.env.FAKE_CLAUDE_HANG_TURN === '1';
const multiChunk = process.env.FAKE_CLAUDE_MULTI_CHUNK === '1';

let turn = 0;
let didInit = false;

const args = process.argv.slice(2);
const resumeIdx = args.findIndex((a) => a === '--resume' || a === '-r');
const isResuming = resumeIdx >= 0;
// Use UUID-like values to mirror real Claude Code behavior.
const sessionId = isResuming ? '1433467f-ff14-4292-b5b2-2aac77a808f0' : 'aada10c6-9299-4c45-abc4-91db9c0f935d';

// Claude Code stream-json emits an init message that includes the effective session id.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
didInit = true;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = String(line || '').trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || msg.type !== 'user') return;
  turn += 1;
  if (toolName && turn === 1) {
    // Request permission for a tool call; the parent will reply with a control_response.
    const reqId = 'req-1';
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: reqId, request: { subtype: 'can_use_tool', tool_name: toolName, input: {} } }) + '\\n');
    const onControl = (line2) => {
      const t2 = String(line2 || '').trim();
      if (!t2) return;
      let msg2;
      try { msg2 = JSON.parse(t2); } catch { return; }
      if (!msg2 || msg2.type !== 'control_response') return;
      if (!msg2.response || msg2.response.request_id !== reqId) return;
      rl.off('line', onControl);
      const behavior = msg2.response.response && msg2.response.response.behavior;
      const label = behavior === 'allow' ? 'TOOL_ALLOWED' : 'TOOL_DENIED';
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: label }] } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
    };
    rl.on('line', onControl);
    return;
  }
  if (hangTurn && turn === 1) {
    return;
  }
  if (multiChunk) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn + '_A' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn + '_B' }] } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn }] } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;
}

type BackendRunContext = {
  backend: {
    onMessage: (handler: (msg: unknown) => void) => void;
    startSession: () => Promise<{ sessionId: string }>;
    sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
    dispose: () => Promise<void>;
  };
  dir: string;
  logPath: string;
};

async function withFakeClaudeBackend(
  params: Readonly<{
    dirPrefix: string;
    permissionPolicy: 'no_tools' | 'read_only';
    toolName?: string;
    hangTurn?: boolean;
    multiChunk?: boolean;
    modelId?: string;
    includeLogPath?: boolean;
  }>,
  run: (ctx: BackendRunContext) => Promise<void>,
): Promise<void> {
  let dir: string | null = null;
  let backend: BackendRunContext['backend'] | null = null;
  const logPath = params.includeLogPath === false ? '' : 'argv.jsonl';

  try {
    dir = await mkdtemp(join(tmpdir(), params.dirPrefix));
    const entry = join(dir, 'fake-claude.cjs');
    await writeFile(entry, createFakeClaudeEntrypointSource(), 'utf8');

    process.env.HAPPIER_CLAUDE_PATH = entry;
    if (params.includeLogPath === false) {
      delete process.env.FAKE_CLAUDE_LOG_PATH;
    } else {
      process.env.FAKE_CLAUDE_LOG_PATH = join(dir, logPath);
    }
    if (params.toolName) {
      process.env.FAKE_CLAUDE_TOOL_NAME = params.toolName;
    } else {
      delete process.env.FAKE_CLAUDE_TOOL_NAME;
    }
    process.env.FAKE_CLAUDE_HANG_TURN = params.hangTurn ? '1' : '0';
    process.env.FAKE_CLAUDE_MULTI_CHUNK = params.multiChunk ? '1' : '0';

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    backend = new ClaudeSdkAgentBackend({
      cwd: dir,
      modelId: params.modelId ?? 'chat-model',
      permissionPolicy: params.permissionPolicy,
    });

    await run({
      backend,
      dir,
      logPath: params.includeLogPath === false ? '' : join(dir, logPath),
    });
  } finally {
    if (backend) {
      try {
        await backend.dispose();
      } catch {
        // Best-effort dispose in tests.
      }
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

describe('ClaudeSdkAgentBackend', () => {
  const originalClaudePath = process.env.HAPPIER_CLAUDE_PATH;
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    if (originalClaudePath === undefined) {
      delete process.env.HAPPIER_CLAUDE_PATH;
    } else {
      process.env.HAPPIER_CLAUDE_PATH = originalClaudePath;
    }
    delete process.env.FAKE_CLAUDE_LOG_PATH;
    delete process.env.FAKE_CLAUDE_TOOL_NAME;
    delete process.env.FAKE_CLAUDE_HANG_TURN;
    delete process.env.FAKE_CLAUDE_MULTI_CHUNK;
    if (originalDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = originalDebug;
    }
  });

  it('emits cumulative model-output fullText when Claude returns multiple assistant messages in a single turn', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-chunks-',
        permissionPolicy: 'no_tools',
        multiChunk: true,
      },
      async ({ backend }) => {
        const fullTexts: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            fullTexts.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');

        expect(fullTexts.length).toBeGreaterThan(0);
        const last = fullTexts[fullTexts.length - 1]!;
        expect(last).toContain('FAKE_ASSIST_1_A');
        expect(last).toContain('FAKE_ASSIST_1_B');
      },
    );
  });

  it('supports multi-turn sendPrompt and passes the model id through to the spawned process', async () => {
    // Keep unit tests quiet even if the parent env has DEBUG set.
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-',
        permissionPolicy: 'no_tools',
        modelId: 'chat-model',
      },
      async ({ backend, logPath }) => {
        const seen: string[] = [];
        const statuses: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
          if (msg.type === 'status' && typeof msg.status === 'string') {
            statuses.push(msg.status);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await backend.sendPrompt(sessionId, 'again');

        expect(seen.join(' ')).toContain('FAKE_ASSIST_1');
        expect(seen.join(' ')).toContain('FAKE_ASSIST_2');

        const argvLog = (await import('node:fs/promises')).readFile(logPath, 'utf8');
        expect(await argvLog).toContain('--model');
        expect(await argvLog).toContain('chat-model');

        expect(statuses.filter((s) => s === 'running')).toHaveLength(1);
      },
    );
  });

  it('allows non-write-like tool calls in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'fetch',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        expect(seen.join(' ')).toContain('TOOL_ALLOWED');
      },
    );
  });

  it('denies write-like tool calls in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'write_file',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies unknown tools in read_only policy (default-deny)', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'custom_tool',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('rejects a pending turn when disposed', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-dispose-',
        permissionPolicy: 'no_tools',
        hangTurn: true,
      },
      async ({ backend }) => {
        const { sessionId } = await backend.startSession();
        const pending = backend.sendPrompt(sessionId, 'this will hang');

        await new Promise((resolve) => setTimeout(resolve, 30));
        await backend.dispose();

        const settled = await Promise.race([
          pending.then(
            () => 'resolved',
            (error) => `rejected:${error instanceof Error ? error.message : String(error)}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300)),
        ]);
        expect(settled).toBe('rejected:Agent disposed');
      },
    );
  });

  it('supports loadSession by passing --resume and emitting vendor_session_id', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-resume-',
        permissionPolicy: 'no_tools',
      },
      async ({ backend, logPath }) => {
        const events: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg?.type === 'event') events.push(msg);
        });

        const loaded = await (backend as any).loadSession('aada10c6-9299-4c45-abc4-91db9c0f935d');
        expect(loaded?.sessionId).toBe('1433467f-ff14-4292-b5b2-2aac77a808f0');

        await backend.sendPrompt(loaded.sessionId, 'hi');

        const argvLog = (await import('node:fs/promises')).readFile(logPath, 'utf8');
        const logText = await argvLog;
        expect(logText).toContain('--resume');
        expect(logText).toContain('aada10c6-9299-4c45-abc4-91db9c0f935d');

        expect(
          events.some(
            (e) => e?.name === 'vendor_session_id' && e?.payload && e.payload.sessionId === '1433467f-ff14-4292-b5b2-2aac77a808f0',
          ),
        ).toBe(true);
      },
    );
  });
});
