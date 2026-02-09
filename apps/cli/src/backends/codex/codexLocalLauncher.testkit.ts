import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

export type LocalLauncherMode = Readonly<{ permissionMode: PermissionMode }>;

type SessionMetadataState = { codexSessionId: string | null };
type CodexBody = { type?: string; message?: string; id?: string; callId?: string };
type SessionEvent = { type?: string; message?: string };

const TRACKED_ENV_KEYS = [
  'HAPPIER_CODEX_SESSIONS_DIR',
  'HAPPIER_CODEX_TUI_BIN',
  'TEST_CODEX_SESSION_ID',
  'TEST_CODEX_TIMESTAMP',
  'TEST_CODEX_ARGV_PATH',
] as const;

export type LocalSessionHarness = {
  session: ApiSessionClient;
  codexMessages: CodexBody[];
  sessionEvents: SessionEvent[];
  metadataUpdates: SessionMetadataState[];
};

export async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const intervalMs = opts?.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

export async function createCodexBinaryFixture(): Promise<{
  sessionsRoot: string;
  binDir: string;
  fakeCodex: string;
  terminatedFlag: string;
}> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'happier-codex-sessions-'));
  const binDir = await mkdtemp(join(tmpdir(), 'happier-codex-bin-'));
  const fakeCodex = join(binDir, 'codex');
  const terminatedFlag = join(binDir, 'terminated');
  return { sessionsRoot, binDir, fakeCodex, terminatedFlag };
}

export async function cleanupCodexBinaryFixture(fixture: { sessionsRoot: string; binDir: string }): Promise<void> {
  await rm(fixture.sessionsRoot, { recursive: true, force: true });
  await rm(fixture.binDir, { recursive: true, force: true });
}

export function applyCodexLauncherEnv(vars: Partial<Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>>): () => void {
  const previous: Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined> = {
    HAPPIER_CODEX_SESSIONS_DIR: process.env.HAPPIER_CODEX_SESSIONS_DIR,
    HAPPIER_CODEX_TUI_BIN: process.env.HAPPIER_CODEX_TUI_BIN,
    TEST_CODEX_SESSION_ID: process.env.TEST_CODEX_SESSION_ID,
    TEST_CODEX_TIMESTAMP: process.env.TEST_CODEX_TIMESTAMP,
    TEST_CODEX_ARGV_PATH: process.env.TEST_CODEX_ARGV_PATH,
  };

  for (const key of TRACKED_ENV_KEYS) {
    const next = vars[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  return () => {
    for (const key of TRACKED_ENV_KEYS) {
      const prev = previous[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  };
}

export async function writeFakeCodexScript(path: string, opts: {
  terminatedFlag: string;
  sessionMetaDelayMs?: number;
  assistantText?: string;
  recordArgv: boolean;
  exitAfterMs?: number;
  handleSigint?: boolean;
}): Promise<void> {
  const sessionMetaDelayMs = typeof opts.sessionMetaDelayMs === 'number' ? opts.sessionMetaDelayMs : 0;
  const assistantText = typeof opts.assistantText === 'string' ? opts.assistantText : null;
  const exitAfterMs = typeof opts.exitAfterMs === 'number' ? opts.exitAfterMs : null;
  const handleSigint = opts.handleSigint !== false;

  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.HAPPIER_CODEX_SESSIONS_DIR;
if (!root) throw new Error('Missing HAPPIER_CODEX_SESSIONS_DIR');
fs.mkdirSync(root, { recursive: true });
const filePath = path.join(root, 'rollout-test.jsonl');
const id = process.env.TEST_CODEX_SESSION_ID || 'sid';
const ts = process.env.TEST_CODEX_TIMESTAMP || new Date().toISOString();

function write(line) {
  fs.appendFileSync(filePath, line + '\\n', 'utf8');
}

if (${opts.recordArgv ? 'true' : 'false'}) {
  const argvPath = process.env.TEST_CODEX_ARGV_PATH;
  if (argvPath) {
    fs.writeFileSync(argvPath, JSON.stringify(process.argv), 'utf8');
  }
}

function writeSessionMeta() {
  write(JSON.stringify({ type: 'session_meta', payload: { id, timestamp: ts, cwd: process.cwd() } }));
  ${assistantText ? `write(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ${JSON.stringify(assistantText)} }] } }));` : ''}
}

if (${sessionMetaDelayMs} > 0) {
  setTimeout(writeSessionMeta, ${sessionMetaDelayMs});
} else {
  writeSessionMeta();
}

process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(opts.terminatedFlag)}, 'terminated', 'utf8');
  process.exit(0);
});
${handleSigint ? `process.on('SIGINT', () => {
  fs.writeFileSync(${JSON.stringify(opts.terminatedFlag)}, 'terminated', 'utf8');
  process.exit(0);
});` : ''}

${exitAfterMs != null ? `setTimeout(() => process.exit(0), ${exitAfterMs});` : ''}
setInterval(() => {}, 1000);
`;

  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
}

export function createLocalSessionHarness(): LocalSessionHarness {
  const codexMessages: CodexBody[] = [];
  const sessionEvents: SessionEvent[] = [];
  const metadataUpdates: SessionMetadataState[] = [];

  const session = {
    sendUserTextMessage: (_text: string) => {},
    sendCodexMessage: (body: unknown) => {
      codexMessages.push(body as CodexBody);
    },
    sendSessionEvent: (event: unknown) => {
      sessionEvents.push(event as SessionEvent);
    },
    updateMetadata: (updater: (metadata: SessionMetadataState) => SessionMetadataState) => {
      metadataUpdates.push(updater({ codexSessionId: null }));
    },
    rpcHandlerManager: {
      registerHandler: (_name: string, _handler: unknown) => {},
    },
    peekPendingMessageQueueV2Count: async () => 0,
    discardPendingMessageQueueV2All: async () => 0,
    discardCommittedMessageLocalIds: async (_ids: string[]) => {},
  } as unknown as ApiSessionClient;

  return { session, codexMessages, sessionEvents, metadataUpdates };
}

export function createLocalMessageQueue(): MessageQueue2<LocalLauncherMode> {
  return new MessageQueue2<LocalLauncherMode>((mode) => mode.permissionMode);
}
