import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';
import { createWorkspaceReplicationBaselineStore } from '@/workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';

import { createSessionHandoffWorkspaceReplicationMetadata } from './sessionHandoffWorkspaceReplicationMetadata';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

function makeManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
  const fingerprint = fingerprintWorkspaceManifest({ entries });
  return {
    entries: entries.map((entry) => ({ ...entry })),
    fingerprint,
  };
}

describe('prepareSessionHandoffWorkspaceTarget (one_way_safe baseline enforcement)', () => {
  it('saves a baseline via the engine job runner after a successful sync_changes apply', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-baseline-'));
    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-baseline-target-'));

    try {
      const fileContents = 'hello baseline\n';
      const fileDigest = `sha256:${createHash('sha256').update(fileContents).digest('hex')}`;
      const seedPath = join(activeServerDir, 'seed.txt');
      await writeFile(seedPath, fileContents, 'utf8');

      const cas = createWorkspaceReplicationCasStore({ activeServerDir });
      await cas.commitFile({
        digest: fileDigest,
        sourcePath: seedPath,
      });

      // `sync_changes` in one_way_safe mode requires an existing baseline. Seed it by asserting that the target
      // currently matches the baseline state (so divergence checks can pass).
      await writeFile(join(targetWorkspaceRoot, 'README.md'), fileContents, 'utf8');

      const sourceManifest = makeManifest([
        {
          relativePath: 'README.md',
          kind: 'file',
          digest: fileDigest,
          sizeBytes: Buffer.byteLength(fileContents),
          executable: false,
        },
      ]);

      const metadata = createSessionHandoffWorkspaceReplicationMetadata({
        sourceRootPath: '/source',
        workspaceExportArtifacts: {
          manifest: sourceManifest,
        },
      });
      if (!metadata) {
        throw new Error('Expected workspace replication metadata to be available');
      }

      const offer = {
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: sourceManifest.fingerprint!,
        manifest: sourceManifest,
        blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
      } as const;

      const onWorkspaceReplicationJobStarted = vi.fn(async () => undefined);

      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: '/source',
          targetMachineId: 'machine_target',
          targetWorkspaceRoot,
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: sourceManifest.fingerprint!,
          manifest: sourceManifest,
          savedAtMs: 1,
        },
      });

      await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'server_routed_stream',
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: targetWorkspaceRoot,
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
        } as any,
        metadata,
        machineTransferChannel: {
          onEnvelope: () => () => {},
          sendEnvelope: () => {},
        } as any,
        transfers: {
          requestServerRoutedSourceOffer: async () => offer,
          requestServerRoutedBlobPackToFile: async () => {
            throw new Error('Unexpected blob-pack request (CAS already seeded)');
          },
        } as any,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
        onWorkspaceReplicationJobStarted,
      });

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const jobRecord = await jobStore.findByCorrelationId('session_handoff_workspace_prepare_target:handoff_1');
      expect(jobRecord).not.toBeNull();
      expect(onWorkspaceReplicationJobStarted).toHaveBeenCalledWith(jobRecord!.jobId);
      expect(jobRecord!.status.status).toBe('completed');
      expect(jobRecord!.status.checkpoint).toBe('baseline_committed');

      const baseline = await baselineStore.load({
        sourceMachineId: 'machine_source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine_target',
        targetWorkspaceRoot,
        mode: 'one_way_safe',
      });
      expect(baseline).not.toBeNull();
      expect(baseline).toMatchObject({
        manifestFingerprint: sourceManifest.fingerprint,
        manifest: sourceManifest,
      });
      expect(typeof baseline!.savedAtMs).toBe('number');

      const written = await readFile(join(targetWorkspaceRoot, 'README.md'), 'utf8');
      expect(written).toBe(fileContents);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('falls back to transfer_snapshot when sync_changes baseline is missing (one_way_safe)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-missing-baseline-'));
    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-missing-baseline-target-'));

    try {
      const fileContents = 'hello missing baseline\n';
      const fileDigest = `sha256:${createHash('sha256').update(fileContents).digest('hex')}`;
      const seedPath = join(activeServerDir, 'seed.txt');
      await writeFile(seedPath, fileContents, 'utf8');

      const cas = createWorkspaceReplicationCasStore({ activeServerDir });
      await cas.commitFile({
        digest: fileDigest,
        sourcePath: seedPath,
      });

      const sourceManifest = makeManifest([
        {
          relativePath: 'README.md',
          kind: 'file',
          digest: fileDigest,
          sizeBytes: Buffer.byteLength(fileContents),
          executable: false,
        },
      ]);

      const metadata = createSessionHandoffWorkspaceReplicationMetadata({
        sourceRootPath: '/source',
        workspaceExportArtifacts: {
          manifest: sourceManifest,
        },
      });
      if (!metadata) {
        throw new Error('Expected workspace replication metadata to be available');
      }

      const offer = {
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: sourceManifest.fingerprint!,
        manifest: sourceManifest,
        blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
      } as const;

      const onWorkspaceReplicationJobStarted = vi.fn(async () => undefined);

      const result = await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'server_routed_stream',
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: targetWorkspaceRoot,
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
        } as any,
        metadata,
        machineTransferChannel: {
          onEnvelope: () => () => {},
          sendEnvelope: () => {},
        } as any,
        transfers: {
          requestServerRoutedSourceOffer: async () => offer,
          requestServerRoutedBlobPackToFile: async () => {
            throw new Error('Unexpected blob-pack request (CAS already seeded)');
          },
        } as any,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
        onWorkspaceReplicationJobStarted,
      });

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const jobRecord = await jobStore.findByCorrelationId('session_handoff_workspace_prepare_target:handoff_1');
      expect(jobRecord).not.toBeNull();
      expect(onWorkspaceReplicationJobStarted).toHaveBeenCalledWith(jobRecord!.jobId);
      expect(jobRecord!.status.status).toBe('completed');
      expect(jobRecord!.status.checkpoint).toBe('baseline_committed');
      expect(jobRecord!.resumeContext?.apply.strategy).toBe('transfer_snapshot');
      expect(jobRecord!.result?.targetPath).toBe(result.importedWorkspace.targetPath);

      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
      const baseline = await baselineStore.load({
        sourceMachineId: 'machine_source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine_target',
        targetWorkspaceRoot,
        mode: 'one_way_safe',
      });
      expect(baseline).not.toBeNull();

      const written = await readFile(join(result.importedWorkspace.targetPath, 'README.md'), 'utf8');
      expect(written).toBe(fileContents);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the target diverged since the last baseline (one_way_safe)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-diverged-'));
    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-diverged-target-'));

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

      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: '/source',
          targetMachineId: 'machine_target',
          targetWorkspaceRoot,
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: sourceManifest.fingerprint!,
          manifest: sourceManifest,
          savedAtMs: 1,
        },
      });

      await writeFile(join(targetWorkspaceRoot, 'a.txt'), 'a');
      await writeFile(join(targetWorkspaceRoot, 'b.txt'), 'b');

      const offer = {
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: sourceManifest.fingerprint!,
        manifest: sourceManifest,
        blobIndex: [],
      } as const;

      await expect(
        prepareSessionHandoffWorkspaceTarget({
          activeServerDir,
          actualTransportStrategy: 'server_routed_stream',
          handoffId: 'handoff_2',
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          targetPath: targetWorkspaceRoot,
          workspaceTransfer: {
            enabled: true,
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
          } as any,
          metadata,
          machineTransferChannel: {
            onEnvelope: () => () => {},
            sendEnvelope: () => {},
          } as any,
          transfers: {
            requestServerRoutedSourceOffer: async () => offer,
            requestServerRoutedBlobPackToFile: async () => {
              throw new Error('Unexpected blob-pack request');
            },
          } as any,
          blobPackTargetBytes: 1,
          blobPackMaxBlobs: 1,
          blobPackMaxSingleBlobBytes: 1,
        }),
      ).rejects.toThrow(/diverged/i);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetWorkspaceRoot, { recursive: true, force: true });
    }
  });
});
