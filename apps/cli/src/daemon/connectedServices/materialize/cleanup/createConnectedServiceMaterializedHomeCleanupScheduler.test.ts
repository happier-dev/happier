import { mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { TrackedSession } from '../../../types';
import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './createConnectedServiceMaterializedHomeCleanupScheduler';
import { readRetainedConnectedServiceMaterializationKeys } from './readRetainedConnectedServiceMaterializationKeys';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Inject filesystem failures at the OS boundary while retaining the factory,
// metadata decoding, retention selection and real eventual deletion.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

async function createIdentityRoot(baseDir: string, materializationKey: string): Promise<string> {
  const root = join(baseDir, normalizeMaterializationKeyForPath(materializationKey));
  await mkdir(join(root, 'codex'), { recursive: true });
  await utimes(root, new Date(1_000), new Date(1_000));
  return root;
}

describe('createConnectedServiceMaterializedHomeCleanupScheduler', () => {
  it('does not reclaim a retained home through an aliased attempts directory', async () => {
    const root = await createTempDir('happier-materialized-attempt-alias-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const baseDir = join(root, 'materialized');
      const retained = await createIdentityRoot(baseDir, 'retained-home');
      const agentHome = join(retained, 'codex');
      await utimes(agentHome, new Date(1_000), new Date(1_000));
      await symlink(retained, join(baseDir, '.attempts'), 'dir');
      const scheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 10_000, orphanTtlMs: 1_000, attemptTtlMs: 1_000,
        trackedSessionsByKey: new Map(), getRetainedMaterializationKeys: async () => ['retained-home'],
      });
      await scheduler.reconcile();
      await expect(stat(agentHome)).resolves.toBeTruthy();
    } finally {
      envScope.restore(); reloadConfiguration(); await removeTempDir(root);
    }
  });

  it('retains live and recoverable Run homes but reclaims a settled Run without native resume identity', async () => {
    const root = await createTempDir('happier-run-home-retention-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const state: ExecutionRunState = {
        runId: 'recoverable-run', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: 'native-thread' },
      };
      await retainExecutionRunState(state);
      await retainExecutionRunState({ ...state, runId: 'live-run', status: 'running', resumeHandle: null });
      await retainExecutionRunState({ ...state, runId: 'unrecoverable-run', resumeHandle: null });
      await retainExecutionRunState({ ...state, runId: 'native-state-missing', error: { code: 'execution_run_provider_state_missing' } });
      const baseDir = join(root, 'materialized');
      const recoverable = await createIdentityRoot(baseDir, state.runId);
      const live = await createIdentityRoot(baseDir, 'live-run');
      const orphan = await createIdentityRoot(baseDir, 'unrecoverable-run');
      const missing = await createIdentityRoot(baseDir, 'native-state-missing');
      const scheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 10_000, orphanTtlMs: 1_000, trackedSessionsByKey: new Map(),
        getRetainedMaterializationKeys: async () => [],
      });
      await scheduler.reconcile();
      await expect(stat(recoverable)).resolves.toBeTruthy();
      await expect(stat(live)).resolves.toBeTruthy();
      await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
      const unknown = await createIdentityRoot(baseDir, 'unknown-custody');
      await writeFile(join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', 'run-corrupt.json'), '{');
      await expect(scheduler.reconcile()).rejects.toMatchObject({ code: 'execution_run_home_retention_unavailable' });
      await expect(stat(unknown)).resolves.toBeTruthy();
    } finally {
      envScope.restore(); reloadConfiguration(); await removeTempDir(root);
    }
  });

  it('recovers cleanup after four busy passes while preserving decoded live and resumable identities', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-factory-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const baseDir = join(root, 'materialized');
      const liveRoot = await createIdentityRoot(baseDir, 'csm_live-identity');
      const resumableRoot = await createIdentityRoot(baseDir, 'csm_resumable-identity');
      const orphanRoot = await createIdentityRoot(baseDir, 'csm_orphan-identity');
      // ../0.2 resolveConnectedServiceMaterializedRootDir uses identity.id directly.
      const predecessorRoot = join(baseDir, 'csm_resumable-identity');
      const predecessorOrphan = join(baseDir, 'csm_retired-predecessor');
      for (const home of [predecessorRoot, predecessorOrphan]) {
        await mkdir(join(home, 'codex'), { recursive: true });
        await utimes(home, new Date(1_000), new Date(1_000));
      }
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
        [legacyPidSessionTrackingKey(123), {
          trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
          pid: 123,
          spawnOptions: {
            directory: '/repo',
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'csm_live-identity',
              createdAt: 1_000,
            },
          },
        }],
      ]);

      const scheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        trackedSessionsByKey,
        getRetainedMaterializationKeys: async () => await readRetainedConnectedServiceMaterializationKeys({
          credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
          getAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
          fetchSessionsPage: async ({ archivedOnly }) => ({
            sessions: archivedOnly ? [{ active: false, archivedAt: 1_000, encryptionMode: 'plain',
              metadata: JSON.stringify({ v: 1 }),
              metadataLayoutVersion: 1, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                SessionOwnerMetadataV1Schema.parse({ v: 1, connectedServices: {
                  connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_resumable-identity', createdAt: 1_000 },
                } }),
              ),
            }] : [], nextCursor: null, hasNext: false,
          }),
        }),
      });

      const removePath = vi.mocked(rm);
      for (let pass = 0; pass < 4; pass += 1) {
        removePath.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
        await expect(scheduler.reconcile()).rejects.toMatchObject({ code: 'EBUSY' });
        for (const home of [liveRoot, resumableRoot, predecessorRoot, orphanRoot, predecessorOrphan]) {
          await expect(stat(home)).resolves.toBeTruthy();
        }
      }
      await scheduler.cleanupPendingMaterializedHomes();

      await expect(stat(liveRoot)).resolves.toBeTruthy();
      await expect(stat(resumableRoot)).resolves.toBeTruthy();
      await expect(stat(predecessorRoot)).resolves.toBeTruthy();
      await expect(stat(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(predecessorOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.mocked(rm).mockReset().mockImplementation(
        (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm,
      );
      envScope.restore(); reloadConfiguration();
      await removeTempDir(root);
    }
  });
});
