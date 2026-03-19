import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });
type RemoteBackend = 'acp' | 'appServer';

async function createLocalSwitchBlockerCodexStub(params: Readonly<{
  testDir: string;
}>): Promise<Readonly<{
  fakeCodexPath: string;
  rolloutPath: string;
  codexSessionsDir: string;
}>> {
  const fakeBinDir = resolve(join(params.testDir, 'fake-bin'));
  const codexSessionsDir = resolve(join(params.testDir, 'codex-sessions'));
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });

  const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
  const rolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));

  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.appendFileSync(path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')}), JSON.stringify({ type: 'session_meta', payload: { id: 'should-not-run' } }) + '\\n', 'utf8');
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  await chmod(fakeCodexPath, 0o755);

  return {
    fakeCodexPath,
    rolloutPath,
    codexSessionsDir,
  };
}

async function enqueueBlockingPendingMessages(params: Readonly<{
  secret: Uint8Array;
  serverBaseUrl: string;
  sessionId: string;
  token: string;
}>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const localId = `pending-${randomUUID()}`;
    const msg = {
      role: 'user',
      content: { type: 'text', text: `PENDING_MESSAGE_SHOULD_BLOCK_SWITCH_${i}` },
      localId,
      meta: { source: 'ui', sentFrom: 'e2e' },
    };
    const ciphertext = encryptLegacyBase64(msg, params.secret);
    const enqueue = await enqueuePendingQueueV2({
      baseUrl: params.serverBaseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId,
      ciphertext,
      timeoutMs: 20_000,
    });
    expect(enqueue.status).toBe(200);
  }

  await waitFor(async () => {
    const snap: any = await fetchSessionV2(params.serverBaseUrl, params.token, params.sessionId);
    return typeof snap.pendingCount === 'number' && snap.pendingCount > 0;
  }, { timeoutMs: 20_000 });
}

describe('core e2e: Codex remote→local switch fails closed when pending messages exist', () => {
  it('rejects remote→local switch while pending queue V2 has items', async () => {
    await runRemoteToLocalFailClosedPendingScenario({ remoteBackend: 'acp' });
  }, 240_000);

  it('rejects app-server remote→local switch while pending queue V2 has items', async () => {
    await runRemoteToLocalFailClosedPendingScenario({ remoteBackend: 'appServer' });
  }, 240_000);
});

async function runRemoteToLocalFailClosedPendingScenario(params: Readonly<{
  remoteBackend: RemoteBackend;
}>): Promise<void> {
  const testName = params.remoteBackend === 'appServer'
    ? 'codex-switch-remote-to-local-fail-closed-app-server'
    : 'codex-switch-remote-to-local-fail-closed';
  const testDir = run.testDir(testName);
  const startedAt = new Date().toISOString();
  const localCodex = await createLocalSwitchBlockerCodexStub({ testDir });

  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  try {
    if (params.remoteBackend === 'appServer') {
      harness = await startCodexAppServerRemoteHarness({
        testDir,
        runId: run.runId,
        testName,
        cliEnvOverrides: {
          HAPPIER_CODEX_TUI_BIN: localCodex.fakeCodexPath,
          HAPPIER_CODEX_SESSIONS_DIR: localCodex.codexSessionsDir,
        },
      });

      const initialRequests = await readFakeCodexAppServerRequestLog(harness.requestLogPath);
      expect(initialRequests.some((entry) => entry.method === 'thread/resume')).toBe(true);

      ui = createUserScopedSocketCollector(harness.serverBaseUrl, harness.auth.token);
      ui.connect();
      await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000 });

      await enqueueBlockingPendingMessages({
        secret: harness.secret,
        serverBaseUrl: harness.serverBaseUrl,
        sessionId: harness.sessionId,
        token: harness.auth.token,
      });

      const switched = await requestSessionSwitchRpc({
        ui,
        sessionId: harness.sessionId,
        to: 'local',
        secret: harness.secret,
        timeoutMs: 20_000,
      });
      expect(switched).toBe(false);

      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(localCodex.rolloutPath)).toBe(false);

      const requestsAfterFailedSwitch = await readFakeCodexAppServerRequestLog(harness.requestLogPath);
      expect(requestsAfterFailedSwitch.some((entry) => entry.method === 'thread/resume')).toBe(true);
      return;
    }

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const now = Date.now();
    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'codex-switch-fail-closed',
        createdAt: now,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-codex-switch-fail-closed-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName,
      sessionIds: [sessionId],
      env: {},
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
      HAPPIER_CODEX_TUI_BIN: localCodex.fakeCodexPath,
      HAPPIER_CODEX_SESSIONS_DIR: localCodex.codexSessionsDir,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv }, { skipSourceFreshnessCheck: true });

    proc = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'codex',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'remote',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();

    const uiCollector = ui;
    if (!uiCollector) throw new Error('UI socket collector was not created');
    await waitFor(() => uiCollector.isConnected(), { timeoutMs: 20_000 });

    await waitFor(async () => {
      const snap: any = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      return snap.active === true;
    }, { timeoutMs: 30_000 });

    await enqueueBlockingPendingMessages({
      secret,
      serverBaseUrl,
      sessionId,
      token: auth.token,
    });

    const switched = await requestSessionSwitchRpc({ ui: uiCollector, sessionId, to: 'local', secret, timeoutMs: 20_000 });
    expect(switched).toBe(false);

    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(localCodex.rolloutPath)).toBe(false);
  } finally {
    ui?.close();
    await proc?.stop();
    await harness?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    const cliHome = harness?.cliHome ?? resolve(join(testDir, 'cli-home'));
    await stopDaemonFromHomeDir(cliHome).catch(() => {});
  }
}
