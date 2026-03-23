import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });
type RemoteBackend = 'acp' | 'appServer';
const requireFromRepoRoot = createRequire(import.meta.url);

type DecryptedSessionMetadata = Readonly<{ codexSessionId?: string }>;
type DecryptedAgentState = Readonly<{ controlledByUser?: boolean }>;
type DecryptedUserTextMessage = Readonly<{
  role?: string;
  content?: Readonly<{ type?: string; text?: string }>;
}>;
type DecryptedAcpAgentMessage = Readonly<{
  role?: string;
  content?: Readonly<{
    type?: string;
    provider?: string;
    data?: Readonly<{ type?: string; message?: string }>;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMetadata(value: unknown): DecryptedSessionMetadata | null {
  return isRecord(value) ? value : null;
}

function readAgentState(value: unknown): DecryptedAgentState | null {
  return isRecord(value) ? value : null;
}

function readUserTextMessage(value: unknown): DecryptedUserTextMessage | null {
  return isRecord(value) ? value as DecryptedUserTextMessage : null;
}

function readAcpAgentMessage(value: unknown): DecryptedAcpAgentMessage | null {
  return isRecord(value) ? value as DecryptedAcpAgentMessage : null;
}

async function runLocalToRemotePendingSwitchScenario(params: Readonly<{
  remoteBackend: RemoteBackend;
}>): Promise<void> {
  const testName = params.remoteBackend === 'appServer'
    ? 'codex-switch-local-to-remote-pending-app-server'
    : 'codex-switch-local-to-remote-pending';
  const testDir = run.testDir(testName);
  const startedAt = new Date().toISOString();

  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;

  try {
    // This scenario validates local→remote switch + pending-queue delivery, not DB portability.
    // Keep sqlite for deterministic metadata propagation across environments.
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const codexSessionsDir = resolve(join(testDir, 'codex-sessions'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: testName,
        createdAt: Date.now(),
        permissionMode: 'default',
        permissionModeUpdatedAt: 1000,
        ...(params.remoteBackend === 'appServer' ? { codexBackendMode: 'appServer' } : {}),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-${testName}-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });

    const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
    const codexSessionId = `codex-session-${randomUUID()}`;
    const rolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
if (!sessionsRoot) throw new Error('Missing HAPPIER_CODEX_SESSIONS_DIR');
fs.mkdirSync(sessionsRoot, { recursive: true });

const filePath = path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')});
const id = process.env.HAPPIER_E2E_CODEX_SESSION_ID;
if (!id) throw new Error('Missing HAPPIER_E2E_CODEX_SESSION_ID');

function write(line) {
  fs.appendFileSync(filePath, line + '\\n', 'utf8');
}

write(JSON.stringify({ type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd: process.cwd() } }));

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(fakeCodexPath, 0o755);

    expect(existsSync(rolloutPath)).toBe(false);

    const sdkEntry = requireFromRepoRoot.resolve('@agentclientprotocol/sdk/dist/acp.js', {
      paths: [resolve(repoRootDir(), 'apps/cli')],
    });
    const acpStubProviderPath = resolve(
      repoRootDir(),
      'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
    );
    const requestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeAppServerPath = params.remoteBackend === 'appServer'
      ? await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath })
      : null;

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
      HAPPIER_PUBLIC_SERVER_URL: '',
      HAPPIER_LOCAL_SERVER_URL: '',
      HAPPIER_ACTIVE_SERVER_ID: '',
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_CODEX_TUI_BIN: fakeCodexPath,
      HAPPIER_CODEX_SESSIONS_DIR: codexSessionsDir,
      HAPPIER_E2E_CODEX_SESSION_ID: codexSessionId,
      ...(params.remoteBackend === 'acp'
        ? {
            HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
            HAPPIER_CODEX_ACP_BIN: acpStubProviderPath,
            HAPPIER_E2E_ACP_SDK_ENTRY: sdkEntry,
          }
        : {
            HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServerPath ?? '',
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
          }),
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

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
        'local',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();

    await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000 });

    // Wait for local-control to come up and publish the Codex session id + controlledByUser.
    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = readMetadata(decryptLegacyBase64Normalized(snap.metadata, secret));
      if (!metadata) return false;
      if (metadata.codexSessionId !== codexSessionId) return false;
      const agentState = snap.agentState ? readAgentState(decryptLegacyBase64Normalized(snap.agentState, secret)) : null;
      return agentState?.controlledByUser === true;
    }, { timeoutMs: 60_000 });

    const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
    const startAfterSeq = baseline.seq ?? 0;

    const marker = `LOCAL_TO_REMOTE_${randomUUID()}`;
    const pendingLocalId = `msg-${randomUUID()}`;
    const userText = params.remoteBackend === 'acp'
      ? `ACP_STUB_USAGE_UPDATE=${marker}`
      : `APP_SERVER_SWITCH_PENDING=${marker}`;
    const ciphertext = encryptLegacyBase64(
      {
        role: 'user',
        content: { type: 'text', text: userText },
        localId: pendingLocalId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      },
      secret,
    );
    const enqueue = await enqueuePendingQueueV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      localId: pendingLocalId,
      ciphertext,
      timeoutMs: 20_000,
    });
    expect(enqueue.status).toBe(200);

    await waitFor(async () => {
      const pending = await listPendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 20_000 });
      return (
        pending.status === 200 &&
        Array.isArray(pending.data?.pending) &&
        pending.data.pending.some((row) => row.localId === pendingLocalId && row.status === 'queued')
      );
    }, { timeoutMs: 20_000 });

    await expect(requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 25_000 })).resolves.toBe(true);

    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const agentState = snap.agentState ? readAgentState(decryptLegacyBase64Normalized(snap.agentState, secret)) : null;
      return agentState?.controlledByUser === false;
    }, { timeoutMs: 60_000 });

    await waitFor(async () => {
      const pending = await listPendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 20_000 });
      return (
        pending.status === 200 &&
        Array.isArray(pending.data?.pending) &&
        pending.data.pending.every((row) => row.localId !== pendingLocalId || row.status !== 'queued')
      );
    }, { timeoutMs: 60_000 });

    if (params.remoteBackend === 'acp') {
      await waitFor(async () => {
        const rows = await fetchMessagesSince({
          baseUrl: serverBaseUrl,
          token: auth.token,
          sessionId,
          afterSeq: startAfterSeq,
        });

        let sawUser = false;
        let sawAgent = false;
        for (const row of rows) {
          const userOrAgentMessage = decryptLegacyBase64Normalized(row.content.c, secret);
          const userMessage = readUserTextMessage(userOrAgentMessage);
          const agentMessage = readAcpAgentMessage(userOrAgentMessage);

          if (row.localId === pendingLocalId && userMessage?.role === 'user') {
            const content = userMessage.content;
            if (content?.type === 'text' && content.text === userText) {
              sawUser = true;
            }
          }

          if (agentMessage?.role !== 'agent') continue;
          const content = agentMessage.content;
          if (content?.type !== 'acp' || content.provider !== 'codex') continue;
          const data = content.data;
          if (data?.type !== 'message') continue;
          const message = data.message;
          if (typeof message === 'string' && message.includes(`ACP_STUB_USAGE_UPDATE_DONE ${marker}`)) {
            sawAgent = true;
          }
        }

        return sawUser && sawAgent;
      }, { timeoutMs: 90_000 });
      return;
    }

    await waitFor(async () => {
      const rows = await fetchMessagesSince({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        afterSeq: startAfterSeq,
      });
      const localRow = rows.find((row) => row.localId === pendingLocalId) ?? null;
      if (!localRow) return false;
      const userRecord = decryptLegacyBase64Normalized(localRow.content.c, secret) as Record<string, unknown> | null;
      const content = userRecord?.content as Record<string, unknown> | undefined;
      if (!(userRecord?.role === 'user' && content?.type === 'text' && content.text === userText)) return false;
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      return typeof snap.seq === 'number' && snap.seq > startAfterSeq;
    }, { timeoutMs: 45_000, context: 'local to remote app-server transcript materializes queued prompt' });

    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: codexSessionId }) }),
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: codexSessionId,
          input: expect.arrayContaining([expect.objectContaining({ type: 'text', text: userText })]),
        }),
      }),
    ]));
  } finally {
    ui?.close();
    await proc?.stop();
    const cliHome = resolve(join(testDir, 'cli-home'));
    await stopDaemonFromHomeDir(cliHome).catch(() => {});
    await server?.stop();
  }
}

describe('core e2e: Codex local→remote switch drains pending UI message', () => {
  it('switches to remote after a pending message is enqueued, then runs that message via Codex ACP', async () => {
    await runLocalToRemotePendingSwitchScenario({ remoteBackend: 'acp' });
  }, 240_000);

  it('switches to app-server remote after a pending message is enqueued, then drains that message through the app-server runtime', async () => {
    await runLocalToRemotePendingSwitchScenario({ remoteBackend: 'appServer' });
  }, 240_000);
});
