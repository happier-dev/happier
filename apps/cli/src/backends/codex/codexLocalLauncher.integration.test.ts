import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('codexLocalLauncher', () => {
	  it('does not forward CODEX_THREAD_ID to the Codex TUI child process', async () => {
    const fixture = await createCodexBinaryFixture();
    const threadIdPath = join(fixture.binDir, 'thread-id.txt');
    const envDumpPath = join(fixture.binDir, 'codex-env.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      recordThreadId: true,
      recordCodexEnv: true,
      exitAfterMs: 1_500,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      CODEX_THREAD_ID: 'poisoned-parent-thread',
      CODEX_CI: '1',
      CODEX_SHELL: '1',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      TEST_CODEX_THREAD_ID_PATH: threadIdPath,
      TEST_CODEX_ENV_DUMP_PATH: envDumpPath,
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
      CODEX_HOME: undefined,
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
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(existsSync(threadIdPath)).toBe(true);
      }, { timeoutMs: 5_000 });
      await waitFor(() => {
        expect(existsSync(envDumpPath)).toBe(true);
      }, { timeoutMs: 5_000 });

      const forwarded = await readFile(threadIdPath, 'utf8');
      expect(forwarded).toBe('');

	      const envDump = JSON.parse(await readFile(envDumpPath, 'utf8')) as Record<string, unknown>;
	      expect(envDump.CODEX_THREAD_ID).toBeUndefined();
	      expect(envDump.CODEX_CI).toBe('1');
	      expect(envDump.CODEX_SHELL).toBeUndefined();
	      expect(envDump.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('preserves allowlisted CODEX_* env vars for the Codex TUI child process', async () => {
    const fixture = await createCodexBinaryFixture();
    const envDumpPath = join(fixture.binDir, 'codex-env.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      recordCodexEnv: true,
      exitAfterMs: 1_500,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      CODEX_THREAD_ID: 'poisoned-parent-thread',
      CODEX_CI: '1',
      CODEX_SHELL: '1',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      TEST_CODEX_ENV_DUMP_PATH: envDumpPath,
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
      TEST_CODEX_THREAD_ID_PATH: undefined,
      CODEX_HOME: undefined,
    });

	    const prevPreserve = process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS;
	    process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS = 'CODEX_SHELL';

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
        rolloutDiscovery: {
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(existsSync(envDumpPath)).toBe(true);
      }, { timeoutMs: 5_000 });

	      const envDump = JSON.parse(await readFile(envDumpPath, 'utf8')) as Record<string, unknown>;
	      expect(envDump.CODEX_THREAD_ID).toBeUndefined();
	      expect(envDump.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();

	      // CODEX_CI should be preserved by default.
	      expect(envDump.CODEX_CI).toBe('1');

	      // Allowlisted values should be preserved.
	      expect(envDump.CODEX_SHELL).toBe('1');

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      if (prevPreserve === undefined) delete process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS;
      else process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS = prevPreserve;
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('launches a JS-backed Codex override even when PATH does not contain node', async () => {
    const fixture = await createCodexBinaryFixture();
    const envDumpPath = join(fixture.binDir, 'codex-env.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      recordCodexEnv: true,
      exitAfterMs: 1_500,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      CODEX_CI: '1',
      TEST_CODEX_ENV_DUMP_PATH: envDumpPath,
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
      TEST_CODEX_THREAD_ID_PATH: undefined,
      CODEX_HOME: undefined,
    });
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = join(fixture.binDir, 'empty-path');

      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
        rolloutDiscovery: {
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(existsSync(envDumpPath)).toBe(true);
      }, { timeoutMs: 1_000 });

      const envDump = JSON.parse(await readFile(envDumpPath, 'utf8')) as Record<string, unknown>;
      expect(envDump.CODEX_CI).toBe('1');

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('discovers rollout files under CODEX_HOME/sessions when HAPPIER_CODEX_SESSIONS_DIR is unset', async () => {
    const fixture = await createCodexBinaryFixture();
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-home-'));
    const sessionsDir = join(codexHome, 'sessions');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      assistantText: 'hello-from-local',
      recordArgv: false,
      exitAfterMs: 1_500,
    });

    const { session, codexMessages } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: undefined,
      CODEX_HOME: codexHome,
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
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(codexMessages.some((m) => m.type === 'message' && m.message === 'hello-from-local')).toBe(true);
      }, { timeoutMs: 5_000 });
      await waitFor(() => {
        expect(existsSync(join(sessionsDir, 'rollout-test.jsonl'))).toBe(true);
      }, { timeoutMs: 5_000 });

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('discovers rollout files under ~/sessions when HAPPIER_CODEX_SESSIONS_DIR uses HOME', async () => {
    const fixture = await createCodexBinaryFixture();
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-codex-home-'));
    const sessionsDir = join(homeDir, 'sessions');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      assistantText: 'hello-from-local',
      recordArgv: false,
      exitAfterMs: 1_500,
    });

    const { session, codexMessages } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: '~/sessions',
      CODEX_HOME: undefined,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: sessionId,
      TEST_CODEX_TIMESTAMP: nowIso,
      TEST_CODEX_ARGV_PATH: undefined,
    });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        resumeId: sessionId,
        rolloutDiscovery: {
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(codexMessages.some((m) => m.type === 'message' && m.message === 'hello-from-local')).toBe(true);
      }, { timeoutMs: 5_000 });
      await waitFor(() => {
        expect(existsSync(join(sessionsDir, 'rollout-test.jsonl'))).toBe(true);
      }, { timeoutMs: 5_000 });

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      restoreEnv();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await cleanupCodexBinaryFixture(fixture);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('omits --ask-for-approval and --sandbox when permissionMode is "default" so ~/.codex/config.toml wins', async () => {
    const fixture = await createCodexBinaryFixture();
    const argsPath = join(fixture.binDir, 'argv.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: true,
    });

    const { session } = createLocalSessionHarness();
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
        permissionMode: 'default',
        resumeId: sessionId,
      });

      await waitFor(() => {
        expect(existsSync(argsPath)).toBe(true);
      });
      const argv = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
      expect(argv).not.toContain('--ask-for-approval');
      expect(argv).not.toContain('--sandbox');

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('passes provider-native Codex args after Happier wrapper args', async () => {
    const fixture = await createCodexBinaryFixture();
    const argsPath = join(fixture.binDir, 'argv.json');
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: true,
    });

    const { session } = createLocalSessionHarness();
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
        permissionMode: 'default',
        resumeId: sessionId,
        codexArgs: ['resume', '--all'],
      });

      await waitFor(() => {
        expect(existsSync(argsPath)).toBe(true);
      });
      const argv = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
      const cdIndex = argv.indexOf('--cd');
      expect(cdIndex).toBeGreaterThanOrEqual(0);
      expect(argv.slice(cdIndex, cdIndex + 4)).toEqual(['--cd', fixture.sessionsRoot, 'resume', '--all']);
      expect(argv).not.toContain(sessionId);

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

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

  it('defers UI-triggered remote switch until an active Codex task completes', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      emitTaskStarted: true,
      taskCompleteAfterMs: 300,
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
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });
      let settled = false;
      const observedLauncherPromise = launcherPromise.finally(() => {
        settled = true;
      });

      await waitFor(() => {
        expect(metadataUpdates.some((m) => m && m.codexSessionId === sessionId)).toBe(true);
      });

      messageQueue.push('hi', { permissionMode: 'default' });
      await sleep(100);
      expect(settled).toBe(false);
      expect(existsSync(fixture.terminatedFlag)).toBe(false);

      await expect(observedLauncherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
      await waitFor(() => {
        expect(existsSync(fixture.terminatedFlag)).toBe(true);
      });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('switches after child process exit when an active Codex task never writes a terminal rollout event', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
      emitTaskStarted: true,
      exitAfterMs: 200,
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
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(metadataUpdates.some((m) => m && m.codexSessionId === sessionId)).toBe(true);
      });

      messageQueue.push('hi', { permissionMode: 'default' });

      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('treats switch-to-local requests as a no-op success', async () => {
    const fixture = await createCodexBinaryFixture();
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      recordArgv: false,
    });

    const { session, rpcHandlers } = createLocalSessionHarness();
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
          initialTimeoutMs: 250,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      await waitFor(() => {
        expect(typeof rpcHandlers.switch).toBe('function');
      }, { timeoutMs: 1_000 });

      await expect(rpcHandlers.switch({ to: 'local' })).resolves.toBe(true);

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });
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
      // Keep the fake process alive long enough for the launcher to discover the
      // rollout file and send SIGTERM even on slower machines / crowded CI.
      exitAfterMs: 5_000,
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

  it('switches a fresh local session to remote when no rollout exists', async () => {
    const fixture = await createCodexBinaryFixture();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      writeSessionMeta: false,
      exitAfterMs: 500,
      recordArgv: false,
      handleSigint: false,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: undefined,
      TEST_CODEX_TIMESTAMP: undefined,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        rolloutDiscovery: {
          initialTimeoutMs: 100,
          initialPollIntervalMs: 25,
          extendedPollIntervalMs: 25,
        },
      });

      messageQueue.push('hi', { permissionMode: 'default' });

      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: null });
    } finally {
      restoreEnv();
      await cleanupCodexBinaryFixture(fixture);
    }
  });

  it('keeps native Codex arg invocations local when no rollout exists', async () => {
    const fixture = await createCodexBinaryFixture();

    await writeFakeCodexScript(fixture.fakeCodex, {
      terminatedFlag: fixture.terminatedFlag,
      writeSessionMeta: false,
      exitAfterMs: 120,
      recordArgv: false,
      handleSigint: false,
    });

    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: fixture.fakeCodex,
      TEST_CODEX_SESSION_ID: undefined,
      TEST_CODEX_TIMESTAMP: undefined,
      TEST_CODEX_ARGV_PATH: undefined,
    });

    try {
      const launcherPromise = codexLocalLauncher({
        path: fixture.sessionsRoot,
        api: {},
        session,
        messageQueue,
        permissionMode: 'default',
        codexArgs: ['--help'],
        rolloutDiscovery: {
          initialTimeoutMs: 50,
          initialPollIntervalMs: 20,
          extendedPollIntervalMs: 20,
        },
      });

      messageQueue.push('hi', { permissionMode: 'default' });

      await expect(launcherPromise).resolves.toMatchObject({ type: 'exit' });
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

  it('returns exit when no Codex CLI source is available', async () => {
    const fixture = await createCodexBinaryFixture();
    const { session } = createLocalSessionHarness();
    const messageQueue = createLocalMessageQueue();
    const restoreEnv = applyCodexLauncherEnv({
      HAPPIER_CODEX_SESSIONS_DIR: fixture.sessionsRoot,
      HAPPIER_CODEX_TUI_BIN: undefined,
      TEST_CODEX_SESSION_ID: undefined,
      TEST_CODEX_TIMESTAMP: undefined,
      TEST_CODEX_ARGV_PATH: undefined,
    });
    const originalCodexPath = process.env.HAPPIER_CODEX_PATH;
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    const originalPath = process.env.PATH;

    try {
      delete process.env.HAPPIER_CODEX_PATH;
      process.env.HAPPIER_HOME_DIR = join(fixture.binDir, 'home');
      process.env.PATH = join(fixture.binDir, 'empty-path');

      await expect(
        codexLocalLauncher({
          path: fixture.sessionsRoot,
          api: {},
          session,
          messageQueue,
          permissionMode: 'default',
        }),
      ).resolves.toEqual({ type: 'exit', code: 1 });
    } finally {
      if (originalCodexPath === undefined) delete process.env.HAPPIER_CODEX_PATH;
      else process.env.HAPPIER_CODEX_PATH = originalCodexPath;
      if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
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
