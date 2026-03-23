import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { createScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';

import { prepareSessionHandoffSourceWorkspaceTransfer } from './sessionHandoffWorkspaceReplicationAdapter';

describe('prepareSessionHandoffSourceWorkspaceTransfer (handoffMetadataV2)', () => {
  it('includes sourceRootPath + manifest transfer publication when workspace transfer is enabled (server_routed_stream)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    try {
      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const workspaceExportArtifacts = createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:readme',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:fingerprint',
        },
        sourceControllerMetadata: null,
      });

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        sourceRootPath: '/source',
        workspaceExportArtifacts,
      });

      expect(result.handoffMetadataV2?.workspaceReplicationSourceRootPath).toBe('/source');
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId).toEqual(expect.any(String));
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('includes endpoint candidates in the manifest transfer publication when negotiated transport is direct_peer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    try {
      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const workspaceExportArtifacts = createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'directory',
              relativePath: 'src',
            },
          ],
          fingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        sourceControllerMetadata: null,
      });

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
        sourceRootPath: '/source',
        workspaceExportArtifacts,
        directPeerTransfer: {
          publishTransfer: () => ([
            {
              kind: 'http',
              url: 'http://127.0.0.1:1234/transfer',
              expiresAt: Date.now() + 60_000,
            },
          ]),
        },
      });

      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication).toEqual({
        transferId: expect.any(String),
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:1234/transfer',
            expiresAt: expect.any(Number),
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns no handoffMetadataV2 when workspace transfer is disabled', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    try {
      const workspaceExportArtifacts = createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:readme',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:fingerprint',
        },
        sourceControllerMetadata: null,
      });

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer: {
          enabled: false,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
        sourceRootPath: '/source',
        workspaceExportArtifacts,
      });

      expect(result.handoffMetadataV2).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
