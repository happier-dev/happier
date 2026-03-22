import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';
import { createWorkspaceReplicationBaselineStore } from '@/workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';

import { createSessionHandoffTransferredBundles } from '../transfer/sessionHandoffTransferredBundles';
import { createSessionHandoffWorkspaceReplicationMetadata } from '../workspace/sessionHandoffWorkspaceReplicationMetadata';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

function makeManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
  const fingerprint = fingerprintWorkspaceManifest({ entries });
  return {
    entries: entries.map((entry) => ({ ...entry })),
    fingerprint,
  };
}

describe('prepareSessionHandoffWorkspaceTarget (one_way_safe baseline enforcement)', () => {
  it('saves a baseline after a successful sync_changes apply so future one_way_safe runs can gate divergence', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-baseline-'));

    try {
      const blobContent = Buffer.from('a', 'utf8');
      const blobDigestHex = createHash('sha256').update(blobContent).digest('hex');
      const blobDigest = `sha256:${blobDigestHex}`;

      const sourceManifest = makeManifest([
        {
          relativePath: 'a.txt',
          kind: 'file',
          digest: blobDigest,
          sizeBytes: blobContent.byteLength,
          executable: false,
        },
      ]);
      const blobFilePath = join(activeServerDir, 'source-blob-a.txt');
      await writeFile(blobFilePath, blobContent);

      const metadata = createSessionHandoffWorkspaceReplicationMetadata({
        sourceRootPath: '/source',
        workspaceExportArtifacts: {
          manifest: sourceManifest,
        } as any,
      });

      if (!metadata) {
        throw new Error('Expected workspace replication metadata to be available');
      }

      const targetManifest: WorkspaceManifest = { entries: [] };

      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });

      await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/target',
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'fail',
        } as any,
        metadata,
        transfers: {} as any,
        blobPackTargetBytes: 1,
        blobPackMaxBlobs: 1,
        blobPackMaxSingleBlobBytes: 1,
        persistedTransferredBundles: createSessionHandoffTransferredBundles({}),
        persistedBlobProvider: {
          getBlobFilePath: (digest) => (digest === blobDigest ? blobFilePath : null),
        },
        loadCurrentTargetManifest: async () => targetManifest,
        importWorkspaceBundle: async () => ({ targetPath: '/target' }),
        applyReplicationPlan: async () => ({ targetPath: '/target' }),
      });

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const jobRecord = await jobStore.findByCorrelationId('session_handoff_workspace_prepare_target:handoff_1');
      expect(jobRecord).not.toBeNull();
      expect(jobRecord!.status.status).toBe('completed');
      expect(jobRecord!.status.checkpoint).toBe('baseline_committed');

      const baseline = await baselineStore.load({
        sourceMachineId: 'machine_source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine_target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });
      expect(baseline).not.toBeNull();
      expect(baseline).toMatchObject({
        manifestFingerprint: sourceManifest.fingerprint,
        manifest: sourceManifest,
      });
      expect(typeof baseline!.savedAtMs).toBe('number');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the target diverged since the last baseline (one_way_safe)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-diverged-'));

    try {
      const sourceManifest = makeManifest([
        {
          relativePath: 'a.txt',
          kind: 'file',
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 1,
          executable: false,
        },
      ]);

      const metadata = createSessionHandoffWorkspaceReplicationMetadata({
        sourceRootPath: '/source',
        workspaceExportArtifacts: {
          manifest: sourceManifest,
        } as any,
      });

      if (!metadata) {
        throw new Error('Expected workspace replication metadata to be available');
      }

      const targetManifest = makeManifest([
        {
          relativePath: 'a.txt',
          kind: 'file',
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 1,
          executable: false,
        },
        {
          relativePath: 'b.txt',
          kind: 'file',
          digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 1,
          executable: false,
        },
      ]);

      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: '/source',
          targetMachineId: 'machine_target',
          targetWorkspaceRoot: '/target',
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: sourceManifest.fingerprint!,
          manifest: sourceManifest,
          savedAtMs: 1,
        },
      });

      await expect(
        prepareSessionHandoffWorkspaceTarget({
          activeServerDir,
          actualTransportStrategy: 'direct_peer',
          handoffId: 'handoff_2',
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          targetPath: '/target',
          workspaceTransfer: {
            enabled: true,
            strategy: 'sync_changes',
            conflictPolicy: 'fail',
          } as any,
          metadata,
          transfers: {} as any,
          blobPackTargetBytes: 1,
          blobPackMaxBlobs: 1,
          blobPackMaxSingleBlobBytes: 1,
          persistedTransferredBundles: createSessionHandoffTransferredBundles({}),
          loadCurrentTargetManifest: async () => targetManifest,
          importWorkspaceBundle: async () => ({ targetPath: '/target' }),
          applyReplicationPlan: async () => {
            throw new Error('Expected applyWorkspaceReplicationPlan to not be called when divergence is blocking');
          },
        }),
      ).rejects.toThrow(/diverged/i);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
