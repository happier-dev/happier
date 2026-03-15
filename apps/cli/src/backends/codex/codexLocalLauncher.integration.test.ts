import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { codexLocalLauncher } from './codexLocalLauncher';
import {
  applyCodexLauncherEnv,
  cleanupCodexBinaryFixture,
  createCodexBinaryFixture,
  createLocalMessageQueue,
  createLocalSessionHarness,
  waitFor,
  writeFakeCodexScript,
} from './codexLocalLauncher.testkit';

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

describe('codexLocalLauncher', () => {
  it('maps read-only permission mode to never approvalPolicy', async () => {
    const fixture = await createCodexBinaryFixture();
    const argsPath = join(fixture.binDir, 'argv.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: true,
    });

    const { session, agentStateUpdates } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: argsPath,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'read-only',
        resumeId: sessionId,
      });

      await waitFor(() => {
        expect(existsSync(argsPath)).toBe(true);
      });
      const argv = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
      const idx = argv.indexOf('--ask-for-approval');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(argv[idx + 1]).toBe('never');

      messageQueue.push('hi', { permissionMode: 'read-only' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });

      // Local sessions should publish controlledByUser so the UI can render the local/remote banner.
      expect(agentStateUpdates.some((s) => s.controlledByUser === true)).toBe(true);
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('mirrors rollout events and switches to remote when a UI message arrives', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      assistantText: 'hello-from-local',
      recordArgv: false,
    });

    const { session, codexMessages, metadataUpdates, agentStateUpdates } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
      });

      await waitFor(() => {
        expect(codexMessages.some((m) => m.type === 'message' && m.message === 'hello-from-local')).toBe(true);
      });
      expect(agentStateUpdates.some((s) => s.controlledByUser === true)).toBe(true);

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      expect(agentStateUpdates.some((s) => s.controlledByUser === false)).toBe(true);

      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
      expect(metadataUpdates.some((m) => m && m.codexSessionId === sessionId)).toBe(true);
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('waits for session_meta id before switching to remote', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      sessionMetaDelayMs: 300,
      recordArgv: false,
      handleSigint: false,
    });

    const { session, metadataUpdates } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
        rolloutDiscovery: {
          initialTimeoutMs: 200,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 50,
        },
      });

      messageQueue.push('hi', { permissionMode: 'default' });

      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      expect(metadataUpdates.some((m) => m && m.codexSessionId === sessionId)).toBe(true);
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('keeps searching for rollout files after the initial discovery deadline', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      sessionMetaDelayMs: 400,
      exitAfterMs: 900,
      recordArgv: false,
      handleSigint: false,
    });

    const { session, sessionEvents } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
        rolloutDiscovery: {
          initialTimeoutMs: 200,
          initialPollIntervalMs: 50,
          extendedPollIntervalMs: 50,
        },
      });

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });

      expect(
        sessionEvents.some(
          (event) => event?.type === 'message' && String(event.message || '').includes('continuing to wait'),
        ),
      ).toBe(true);
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('returns exit when the Codex TUI process cannot be spawned', async () => {
    const fixture = await createCodexBinaryFixture();
    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: join(fixture.binDir, 'missing-codex-binary'),
      TEST_CODEX_SESSION_ID: undefined,
      TEST_CODEX_TIMESTAMP: undefined,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const result = await codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
      });

      expect(result.type).toBe('exit');
      if (result.type === 'exit') {
        expect(result.code).not.toBe(0);
      }
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('returns non-zero exit when the Codex TUI is terminated by SIGTERM unexpectedly', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      handleSigint: false,
      handleSigterm: false,
      selfTerminateSignal: 'SIGTERM',
      selfTerminateAfterMs: 150,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const result = await codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
      });

      expect(result).toEqual({ type: 'exit', code: 1 });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('spawns codex.CMD on PATH on Windows when only the .CMD shim exists', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    const codexCmdPath = join(fixture.binDir, 'codex.CMD');
    const fakeCmdExePath = join(fixture.binDir, 'cmd.exe');

    await writeFakeCodexScript(codexCmdPath, {
      terminatedFlag: fixture.terminatedFlag,
      assistantText: 'hello-from-local',
      recordArgv: false,
    });

    const cmdExeScript = `#!/usr/bin/env node
const cp = require('node:child_process');

function splitCommandLine(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    let ch = raw[i];
    if (ch === '^' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === ' ' || next === '\\t') {
        current += next;
        continue;
      }
      ch = next;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\\t')) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const args = process.argv.slice(2);
const cIndex = args.findIndex((a) => String(a).toLowerCase() === '/c');
const rest = cIndex === -1 ? [] : args.slice(cIndex + 1);

if (rest.length === 0) process.exit(1);

let commandLine = rest.join(' ');
if (rest.length === 1) commandLine = rest[0];
if (commandLine.startsWith('"') && commandLine.endsWith('"')) commandLine = commandLine.slice(1, -1);

const tokens = splitCommandLine(commandLine);
if (tokens.length === 0) process.exit(1);

const command = tokens[0];
const commandArgs = tokens.slice(1);

const child = cp.spawn(command, commandArgs, { stdio: 'inherit', env: process.env });

const forward = (signal) => {
  try { child.kill(signal); } catch {}
};

process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); } catch {}
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  const msg = error && error.message ? error.message : String(error);
  console.error(msg);
  process.exit(127);
});
`;

    await writeFile(fakeCmdExePath, cmdExeScript, 'utf8');
    await chmod(fakeCmdExePath, 0o755);

    const { session, codexMessages } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();

    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: undefined,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    try {
      // Keep the real PATH appended so our test shims (written as `#!/usr/bin/env node`) can execute.
      process.env.PATH = originalPath ? `${fixture.binDir}:${originalPath}` : fixture.binDir;
      process.env.PATHEXT = '.CMD';

      await withPlatform('win32', async () => {
        const launcherPromise = codexLocalLauncher({
          path: fixture.sessionsRoot,
          api: {},
          session,
          messageQueue,
          permissionMode: 'default',
          resumeId: sessionId,
        });

        messageQueue.push('hi', { permissionMode: 'default' });
        await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });

        // Sanity: ensure the fake codex wrote at least one event via the rollout mirror.
        expect(codexMessages.some((m) => m.type === 'message' && m.message === 'hello-from-local')).toBe(true);
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;

      if (originalPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathext;

      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });
});
