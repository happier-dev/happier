import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionV2, fetchSessionsV2 } from '../../src/testkit/sessions';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { fetchJson } from '../../src/testkit/http';
import {
  deletePendingQueueV2,
  discardPendingQueueV2,
  enqueuePendingQueueV2,
  listPendingQueueV2,
  patchPendingQueueV2,
  reorderPendingQueueV2,
  restorePendingQueueV2,
} from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: pending queue v2 http CRUD', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function setup(testName: string): Promise<{ testDir: string; auth: Awaited<ReturnType<typeof createTestAuth>>; sessionId: string; startedAt: string; saveArtifactsOnSuccess: boolean }> {
    const testDir = run.testDir(testName);
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    return { testDir, auth, sessionId, startedAt, saveArtifactsOnSuccess };
  }

  it('exposes pendingQueueV2 feature and session badge fields', async () => {
    const { testDir, auth, sessionId, startedAt, saveArtifactsOnSuccess } = await setup('pending-queue-v2-http-crud.features');

    writeTestManifestForServer({
      testDir,
      server: server!,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-http-crud.features',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));
    artifacts.json('sessions.v2.list.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token, { limit: 20 }));

    let passed = false;
    try {
      const features = await fetchJson<any>(`${server!.baseUrl}/v1/features`);
      expect(features.status).toBe(200);
      expect(features.data?.features?.sharing?.pendingQueueV2?.enabled).toBe(true);

      const snap0: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      expect(snap0.pendingCount).toBe(0);
      expect(snap0.pendingVersion).toBe(0);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });

  it('supports enqueue idempotency, list, edit, and reorder', async () => {
    const { testDir, auth, sessionId, startedAt, saveArtifactsOnSuccess } = await setup('pending-queue-v2-http-crud.enqueue-edit-reorder');

    writeTestManifestForServer({
      testDir,
      server: server!,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-http-crud.enqueue-edit-reorder',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('pending.list.json', async () => await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true }));

    let passed = false;
    try {
      const ciphertextA = Buffer.from('pending-a', 'utf8').toString('base64');
      const localIdA = randomUUID();
      const enqueueA = await enqueuePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdA, ciphertext: ciphertextA });
      expect(enqueueA.status).toBe(200);
      expect(enqueueA.data?.didWrite).toBe(true);

      const enqueueA2 = await enqueuePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdA, ciphertext: ciphertextA });
      expect(enqueueA2.status).toBe(200);
      expect(enqueueA2.data?.didWrite).toBe(false);

      const list1 = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId });
      expect(list1.status).toBe(200);
      expect(list1.data.pending?.map((p) => p.localId)).toEqual([localIdA]);

      const ciphertextA2 = Buffer.from('pending-a2', 'utf8').toString('base64');
      const editA = await patchPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdA, ciphertext: ciphertextA2 });
      expect(editA.status).toBe(200);

      const localIdB = randomUUID();
      const ciphertextB = Buffer.from('pending-b', 'utf8').toString('base64');
      const enqueueB = await enqueuePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdB, ciphertext: ciphertextB });
      expect(enqueueB.status).toBe(200);

      const reorder = await reorderPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, orderedLocalIds: [localIdB, localIdA] });
      expect(reorder.status).toBe(200);

      const list2 = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId });
      expect(list2.status).toBe(200);
      expect(list2.data.pending?.map((p) => p.localId)).toEqual([localIdB, localIdA]);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });

  it('supports discard, restore, and delete and updates pendingCount/version', async () => {
    const { testDir, auth, sessionId, startedAt, saveArtifactsOnSuccess } = await setup('pending-queue-v2-http-crud.discard-restore-delete');

    writeTestManifestForServer({
      testDir,
      server: server!,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-http-crud.discard-restore-delete',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));
    artifacts.json('pending.list.json', async () => await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true }));

    let passed = false;
    try {
      const snap0: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      expect(snap0.pendingCount).toBe(0);
      expect(snap0.pendingVersion).toBe(0);

      const localIdA = randomUUID();
      const localIdB = randomUUID();
      await enqueuePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdA, ciphertext: Buffer.from('pending-a', 'utf8').toString('base64') });
      await enqueuePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdB, ciphertext: Buffer.from('pending-b', 'utf8').toString('base64') });

      const snap1: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      expect(snap1.pendingCount).toBe(2);
      expect(snap1.pendingVersion).toBeGreaterThanOrEqual(1);

      const discard = await discardPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdB, reason: 'test' });
      expect(discard.status).toBe(200);

      const listQueued = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId });
      expect(listQueued.data.pending?.map((p) => p.localId)).toEqual([localIdA]);

      const listDiscarded = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true });
      expect(listDiscarded.status).toBe(200);
      expect(listDiscarded.data.pending?.find((p) => p.localId === localIdB)?.status).toBe('discarded');

      const restore = await restorePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdB });
      expect(restore.status).toBe(200);

      const delA = await deletePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdA });
      expect(delA.status).toBe(200);
      const delB = await deletePendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, localId: localIdB });
      expect(delB.status).toBe(200);

      const list5 = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true });
      expect(list5.status).toBe(200);
      expect(list5.data.pending?.length).toBe(0);

      const snap2: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      expect(snap2.pendingCount).toBe(0);
      expect(snap2.pendingVersion).toBeGreaterThanOrEqual(snap1.pendingVersion);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });
});
