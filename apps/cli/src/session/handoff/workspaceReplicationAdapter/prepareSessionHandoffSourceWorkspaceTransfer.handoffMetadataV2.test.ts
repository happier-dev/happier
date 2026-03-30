import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { prepareSessionHandoffSourceWorkspaceTransfer } from './sessionHandoffWorkspaceReplicationAdapter';

describe('prepareSessionHandoffSourceWorkspaceTransfer (handoffMetadataV2)', () => {
  it('includes sourceRootPath + manifest transfer publication when workspace transfer is enabled (server_routed_stream)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await mkdir(join(sourceRootPath, 'nested'), { recursive: true });
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(join(sourceRootPath, 'nested', 'note.txt'), 'note\n');

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        sourceRootPath,
      });

      expect(result.handoffMetadataV2?.workspaceReplicationSourceRootPath).toBe(sourceRootPath);
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId).toEqual(expect.any(String));
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('includes endpoint candidates in the manifest transfer publication when negotiated transport is direct_peer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await mkdir(join(sourceRootPath, 'nested'), { recursive: true });
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(join(sourceRootPath, 'nested', 'note.txt'), 'note\n');

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
        sourceRootPath,
        providerBundleTransferPublication: {
          transferId: 'provider_bundle_1',
          sizeBytes: 123,
          manifestHash: 'sha256:provider_bundle_1',
          endpointCandidates: [
            {
              kind: 'http',
              url: 'http://127.0.0.1:46001/machine-transfers/direct/provider_bundle_1?token=aaa#ignored',
              authorizationToken: 'token_1',
              expiresAt: Date.now() + 60_000,
            },
          ],
        },
      });

      const manifestTransferId = result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId;
      expect(manifestTransferId).toEqual(expect.any(String));
      const expectedEncodedKey = Buffer.from(String(manifestTransferId), 'utf8').toString('base64url');

      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication).toEqual({
        transferId: expect.any(String),
        endpointCandidates: [
          {
            kind: 'http',
            url: `http://127.0.0.1:46001/machine-transfers/direct/${expectedEncodedKey}`,
            authorizationToken: 'token_1',
            expiresAt: expect.any(Number),
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the workspace transfer source root is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-missing-'));
    try {
      await rm(sourceRootPath, { recursive: true, force: true });

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      await expect(prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        sourceRootPath,
      })).rejects.toMatchObject({
        code: 'source_path_unreadable',
        sourcePath: sourceRootPath,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns no handoffMetadataV2 when workspace transfer is disabled', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    try {
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
      });

      expect(result.handoffMetadataV2).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
