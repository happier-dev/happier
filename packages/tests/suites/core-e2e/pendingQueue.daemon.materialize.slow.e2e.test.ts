import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: pending queue v2 daemon materializes into transcript', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('drains pending queue items into the transcript for a daemon-spawned session', async () => {
    const testDir = run.testDir('pending-queue-v2-daemon-materialize');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-daemon-materialize',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
      },
    });

    const artifacts = new FailureArtifacts();

    const mkPrompt = (text: string) => {
      const localId: string = randomUUID();
      const msg = {
        role: 'user',
        content: { type: 'text', text },
        localId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const ciphertext = encryptLegacyBase64(msg, secret);
      return { localId, ciphertext };
    };

    const a = mkPrompt('pending-a');
    const b = mkPrompt('pending-b');
    const c = mkPrompt('pending-c');

    const fakeClaudePath = fakeClaudeFixturePath();

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
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
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const authToken = auth?.token;
    if (!authToken) throw new Error('Missing auth token for artifacts capture');

    artifacts.json('pending.list.json', async () => await listPendingQueueV2({ baseUrl: serverBaseUrl, token: authToken, sessionId, includeDiscarded: true }));
    artifacts.json('transcript.json', async () => await fetchAllMessages(serverBaseUrl, authToken, sessionId));

    // Now that the daemon-spawned session process is running, enqueue pending items.
    // The agent should observe pending-changed and materialize them into the transcript.
    const expectedOrder = [a.localId, b.localId, c.localId];
    for (const item of [a, b, c]) {
      const res = await enqueuePendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, localId: item.localId, ciphertext: item.ciphertext });
      expect(res.status).toBe(200);
    }

    let passed = false;
    try {
      await waitFor(async () => {
        const messages = await fetchAllMessages(serverBaseUrl, authToken, sessionId);
        const present = new Set(expectedOrder);
        const matched = messages.filter((m) => typeof m.localId === 'string' && present.has(m.localId)).length;
        return matched >= expectedOrder.length;
      }, { timeoutMs: 60_000 });

      const messages = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
      const present = new Set(expectedOrder);
      const observed = messages
        .map((m) => m.localId)
        .filter((localId): localId is string => typeof localId === 'string' && present.has(localId));
      expect(observed).toEqual(expectedOrder);

      // Confirm queue drained.
      await waitFor(async () => {
        const pending = await listPendingQueueV2({ baseUrl: serverBaseUrl, token: authToken, sessionId });
        return pending.status === 200 && Array.isArray(pending.data?.pending) && pending.data.pending.length === 0;
      }, { timeoutMs: 60_000 });

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  }, 240_000);
});
