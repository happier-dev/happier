import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer, seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { waitForRegexInFile } from '../../src/testkit/waitForRegexInFile';

const run = createRunDirs({ runLabel: 'core' });

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('core e2e: CLI materializes server pending queue v2', () => {
  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;

  afterEach(async () => {
    await proc?.stop().catch(() => {});
    proc = null;
    await server?.stop();
    server = null;
  });

  it('drains pending queue into transcript for an existing session', async () => {
    const testDir = run.testDir('pending-queue-v2-cli-materialize');
    const startedAt = new Date().toISOString();

    // Use sqlite for determinism; pglite wasm/socket can be flaky in some environments.
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = auth.accountSigningSeed;
    await seedCliAuthForTestAccount({ cliHome, serverUrl: server.baseUrl, auth, mode: 'legacy' });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'pending-queue-cli-materialize',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-pending-queue-cli-materialize-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({
      cliHome,
      sessionId,
      secret,
      encryptionVariant: 'legacy',
    });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-cli-materialize',
      sessionIds: [sessionId],
      env: {},
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const cliDistEntrypoint = await ensureCliDistBuilt({ testDir, env: { ...process.env, CI: '1' } });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
    };

    proc = spawnLoggedProcess({
      command: process.execPath,
      args: [cliDistEntrypoint, 'claude', '--existing-session', sessionId, '--started-by', 'terminal', '--happy-starting-mode', 'remote'],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    try {
      await waitFor(async () => {
        const snap: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true;
      }, { timeoutMs: 30_000 });

      const mkPrompt = (text: string) => {
        const localId: string = randomUUID();
        const msg = { role: 'user', content: { type: 'text', text }, localId, meta: { source: 'ui', sentFrom: 'e2e' } };
        return { localId, ciphertext: encryptLegacyBase64(msg, secret) };
      };

      const a = mkPrompt('pending-a');
      const b = mkPrompt('pending-b');
      const c = mkPrompt('pending-c');
      const expected = [a.localId, b.localId, c.localId];

      for (const item of [a, b, c]) {
        const res = await enqueuePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId: item.localId, ciphertext: item.ciphertext });
        expect(res.status).toBe(200);
      }

      await waitFor(async () => {
        const messages = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
        const present = new Set(expected);
        const matched = messages.filter((m) => typeof m.localId === 'string' && present.has(m.localId)).length;
        return matched >= expected.length;
      }, { timeoutMs: 60_000 });

      const messages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      const present = new Set(expected);
      const observed = messages
        .map((m) => m.localId)
        .filter((localId): localId is string => typeof localId === 'string' && present.has(localId));
      expect(observed).toEqual(expected);

      await waitFor(async () => {
        const pending = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId });
        return pending.status === 200 && Array.isArray(pending.data?.pending) && pending.data.pending.length === 0;
      }, { timeoutMs: 60_000 });
    } finally {
      await proc.stop().catch(() => {});
      proc = null;
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);

  it('stops after terminal auth failure before session socket binding without retry storms or accidental materialization', async () => {
    const testDir = run.testDir('pending-queue-v2-cli-auth-invalid-stops');
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: 'invalid-cli-token',
      secret,
    });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'pending-queue-cli-auth-invalid',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-pending-queue-cli-auth-invalid-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({
      cliHome,
      sessionId,
      secret,
      encryptionVariant: 'legacy',
    });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-cli-auth-invalid-stops',
      sessionIds: [sessionId],
      env: {},
    });

    const localId = randomUUID();
    const ciphertext = encryptLegacyBase64(
      {
        role: 'user',
        content: { type: 'text', text: 'pending-auth-invalid' },
        localId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      },
      secret,
    );
    const enqueue = await enqueuePendingQueueV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      localId,
      ciphertext,
    });
    expect(enqueue.status).toBe(200);

    const fakeClaudePath = fakeClaudeFixturePath();
    const cliDistEntrypoint = await ensureCliDistBuilt({ testDir, env: { ...process.env, CI: '1' } });
    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
    };

    proc = spawnLoggedProcess({
      command: process.execPath,
      args: [cliDistEntrypoint, 'claude', '--existing-session', sessionId, '--started-by', 'terminal', '--happy-starting-mode', 'remote'],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    try {
      const serverLogPath = resolve(join(testDir, 'server.stdout.log'));
      await waitForRegexInFile({
        path: serverLogPath,
        regex: /"url": "\/v2\/account\/settings"/,
        timeoutMs: 60_000,
        context: 'initial auth-invalid account settings probe',
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));

      const serverLog = await readFile(serverLogPath, 'utf8');
      expect(countOccurrences(serverLog, '"url": "/v2/account/settings"')).toBe(1);
      expect(countOccurrences(serverLog, '"url": "/v1/machines"')).toBe(1);
      expect(countOccurrences(serverLog, 'Auth failed - invalid token')).toBe(2);

      const pending = await listPendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        includeDiscarded: true,
      });
      expect(pending.status).toBe(200);
      expect(pending.data?.pending?.map((item: { localId?: string }) => item.localId)).toContain(localId);

      const messages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(messages.some((message) => message.localId === localId)).toBe(false);
    } finally {
      await proc.stop().catch(() => {});
      proc = null;
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
