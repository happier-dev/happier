import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
} from './codexLocalLauncher.testHelpers';

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

    const { session, codexMessages, metadataUpdates } = createLocalSessionHarness();
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

      messageQueue.push('hi', { permissionMode: 'default' });
      await expect(launcherPromise).resolves.toEqual({ type: 'switch', resumeId: sessionId });

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
});
