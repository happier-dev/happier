import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation, type FakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { waitFor } from '../../src/testkit/timing';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: daemon spawn does not drop the first UI message', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('processes a UI message posted immediately after /spawn-session (no retry message needed)', async () => {
    const testDir = run.testDir('daemon-spawn-first-message-not-dropped');
    // Deterministic control-plane timing across environments.
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
    });

    const controlToken = (daemon.state as any)?.controlToken as string | undefined;
    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
        },
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    // Post the very first UI message immediately (this is the upstream failure mode).
    const prompt = 'E2E_DAEMON_FIRST_MESSAGE_SHOULD_NOT_DROP';
    await postEncryptedUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: prompt,
      timeoutMs: 20_000,
    });

    const sdkInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
      fakeLogPath,
      (i) => i.mode === 'sdk',
      { timeoutMs: 60_000, pollMs: 150 },
    );
    expect(sdkInvocation.argv.length).toBeGreaterThan(0);

    await waitFor(async () => {
      const rows = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
      const decrypted = rows
        .map((m) => decryptLegacyBase64(m.content.c, secret))
        .filter((m) => !!m && typeof m === 'object') as any[];

      const sawUser = decrypted.some((m) => m?.role === 'user' && m?.content?.text === prompt);
      const sawAssistant = decrypted.some((m) => m?.role === 'agent' && typeof m?.content?.data?.message?.content?.[0]?.text === 'string');
      return sawUser && sawAssistant;
    }, { timeoutMs: 60_000 });
  }, 240_000);

  it('processes a daemon-seeded initial prompt without dropping the first turn', async () => {
    const testDir = run.testDir('daemon-spawn-initial-prompt-not-dropped');
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
    });

    const controlToken = (daemon.state as any)?.controlToken as string | undefined;
    const prompt = 'E2E_DAEMON_INITIAL_PROMPT_SHOULD_NOT_DROP';
    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
          HAPPIER_DAEMON_INITIAL_PROMPT: prompt,
        },
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    await waitForFakeClaudeInvocation(
      fakeLogPath,
      (i) => i.mode === 'sdk',
      { timeoutMs: 60_000, pollMs: 150 },
    );

    await waitFor(async () => {
      const rows = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
      const decrypted = rows
        .map((m) => decryptLegacyBase64(m.content.c, secret))
        .filter((m) => !!m && typeof m === 'object') as any[];

      const sawUser = decrypted.some((m) => m?.role === 'user' && m?.content?.text === prompt);
      const sawAssistant = decrypted.some((m) => m?.role === 'agent' && m?.content?.data?.message?.content?.[0]?.text === 'FAKE_CLAUDE_OK_1');
      return sawUser && sawAssistant;
    }, { timeoutMs: 60_000 });
  }, 240_000);
});
