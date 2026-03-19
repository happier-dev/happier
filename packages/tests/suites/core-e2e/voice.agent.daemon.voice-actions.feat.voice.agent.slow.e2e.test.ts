import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunEnsureOrStartResponseSchema, ExecutionRunStopResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: voice agent daemon emits parsed voice actions from a real backend process', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('streams voice actions returned by the fake Claude CLI scenario', async () => {
    const testDir = run.testDir('voice-agent-daemon-voice-actions');
    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    const fakeClaudePath = fakeClaudeFixturePath();
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
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
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'voice-actions-send-session-message',
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const started = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      req: {
        runId: null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          chatModelId: 'voice-chat-model',
          commitModelId: 'voice-commit-model',
          idleTtlSeconds: 300,
          initialContext: 'voice action parsing e2e',
          verbosity: 'short',
        },
      },
      secret,
      schema: ExecutionRunEnsureOrStartResponseSchema,
      timeoutMs: 45_000,
    });

    const streamStart = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      req: { runId: started.runId, message: 'Send a quick hello to the session' },
      secret,
      schema: ExecutionRunTurnStreamStartResponseSchema,
      timeoutMs: 45_000,
    });

    let cursor = 0;
    let done: any = null;
    let streamDone = false;
    for (let attempt = 0; attempt < 16 && !streamDone; attempt += 1) {
      const read = await callLegacyEncryptedSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
        req: { runId: started.runId, streamId: streamStart.streamId, cursor, maxEvents: 128 },
        secret,
        schema: ExecutionRunTurnStreamReadResponseSchema,
        timeoutMs: 45_000,
      });
      cursor = read.nextCursor;
      done = (read.events as any[]).find((event) => event?.t === 'done') ?? done;
      streamDone = read.done;
      if (!streamDone) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    expect(streamDone).toBe(true);
    expect(typeof done?.assistantText).toBe('string');
    expect(done?.assistantText.trim().length).toBeGreaterThan(0);
    expect(done?.assistantText).not.toContain('<voice_actions>');
    expect(done?.assistantText).not.toContain('hello from fake voice action');
    expect(done?.actions).toEqual([
      {
        t: 'sendSessionMessage',
        args: { message: 'hello from fake voice action' },
      },
    ]);

    const stop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: started.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop.ok).toBe(true);

    ui.disconnect();
    ui.close();
  }, 420_000);
});
