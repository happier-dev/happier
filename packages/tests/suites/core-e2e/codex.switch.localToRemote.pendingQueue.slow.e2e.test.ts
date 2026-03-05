import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex local→remote switch drains pending UI message', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('switches to remote after a pending message is enqueued, then runs that message via Codex ACP', async () => {
    const testDir = run.testDir('codex-switch-local-to-remote-pending');
    const startedAt = new Date().toISOString();

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
        name: 'codex-switch-local-to-remote-pending',
        createdAt: Date.now(),
        permissionMode: 'default',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-codex-switch-local-to-remote-pending-${randomUUID()}`,
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

    const sdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');
    const acpStubProviderPath = resolve(
      repoRootDir(),
      'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
    );

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'codex-switch-local-to-remote-pending',
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
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
      HAPPIER_CODEX_ACP_NPX_MODE: 'never',
      HAPPIER_CODEX_ACP_BIN: acpStubProviderPath,
      HAPPIER_E2E_ACP_SDK_ENTRY: sdkEntry,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
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

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      // Wait for local-control to come up and publish the Codex session id + controlledByUser.
      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
        if (!metadata || typeof metadata !== 'object') return false;
        if (metadata.codexSessionId !== codexSessionId) return false;
        const agentState = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
        return agentState && typeof agentState === 'object' && agentState.controlledByUser === true;
      }, { timeoutMs: 60_000 });

      const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const startAfterSeq = baseline.seq ?? 0;

      const marker = `LOCAL_TO_REMOTE_${randomUUID()}`;
      const pendingLocalId = `msg-${randomUUID()}`;
      const userText = `ACP_STUB_USAGE_UPDATE=${marker}`;
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

      // UI requests remote-control after pending enqueue for local sessions.
      await expect(requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 25_000 })).resolves.toBe(true);

      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const agentState = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
        return agentState && typeof agentState === 'object' && agentState.controlledByUser === false;
      }, { timeoutMs: 60_000 });

      // Pending row should be materialized and removed from the server queue once remote mode starts.
      await waitFor(async () => {
        const pending = await listPendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 20_000 });
        return (
          pending.status === 200 &&
          Array.isArray(pending.data?.pending) &&
          pending.data.pending.every((row) => row.localId !== pendingLocalId)
        );
      }, { timeoutMs: 60_000 });

      // Remote mode should run the pending message via Codex ACP.
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
          const decrypted = decryptLegacyBase64(row.content.c, secret) as any;
          if (!decrypted || typeof decrypted !== 'object') continue;

          if (row.localId === pendingLocalId && decrypted.role === 'user') {
            const content = decrypted.content;
            if (content && typeof content === 'object' && content.type === 'text' && content.text === userText) {
              sawUser = true;
            }
          }

          if (decrypted.role !== 'agent') continue;
          const content = decrypted.content;
          if (!content || typeof content !== 'object') continue;
          if (content.type !== 'acp') continue;
          if (content.provider !== 'codex') continue;
          const data = content.data;
          if (!data || typeof data !== 'object') continue;
          if (data.type !== 'message') continue;
          const message = (data as any).message;
          if (typeof message === 'string' && message.includes(`ACP_STUB_USAGE_UPDATE_DONE ${marker}`)) {
            sawAgent = true;
          }
        }

        return sawUser && sawAgent;
      }, { timeoutMs: 90_000 });
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
