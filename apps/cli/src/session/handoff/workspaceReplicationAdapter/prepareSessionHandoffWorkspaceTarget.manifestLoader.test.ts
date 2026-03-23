import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { createSessionHandoffTransferredBundles } from '../transfer/sessionHandoffTransferredBundles';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

describe('prepareSessionHandoffWorkspaceTarget (manifest loading)', () => {
  it('loads the current target manifest through the workspace export payload builder', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-manifest-'));

    try {
      const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/target' }));
      const buildWorkspaceExportPayload = vi.fn(async () => ({
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'a.txt',
                kind: 'file',
                digest: 'sha256:deadbeef',
                sizeBytes: 1,
                executable: false,
              },
            ],
            fingerprint: 'sha256:fingerprint',
          } satisfies WorkspaceManifest,
          blobContentsByDigest: new Map(),
        },
      }));

      const res = await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_manifest_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/target',
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'fail',
        } as any,
        transfers: {} as any,
        blobPackTargetBytes: 1,
        blobPackMaxBlobs: 1,
        blobPackMaxSingleBlobBytes: 1,
        persistedTransferredBundles: createSessionHandoffTransferredBundles({}),
        buildWorkspaceExportPayload: buildWorkspaceExportPayload as any,
        importWorkspaceBundle,
      });

      expect(buildWorkspaceExportPayload).toHaveBeenCalledWith({
        activeServerDir,
        sourcePath: '/target',
        workspaceTransfer: expect.objectContaining({ enabled: true, strategy: 'sync_changes' }),
      });
      expect(res.currentTargetManifest).toEqual({
        entries: [
          {
            relativePath: 'a.txt',
            kind: 'file',
            digest: 'sha256:deadbeef',
            sizeBytes: 1,
            executable: false,
          },
        ],
        fingerprint: 'sha256:fingerprint',
      });
      expect(importWorkspaceBundle).toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
