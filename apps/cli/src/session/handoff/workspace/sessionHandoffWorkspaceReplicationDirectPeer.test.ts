import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferEndpointCandidate, WorkspaceManifest } from '@happier-dev/protocol';

import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

function createSha256DigestForPayload(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('session handoff direct-peer workspace replication publication', () => {
  const envSnapshot = { ...process.env };

  afterEach(async () => {
    process.env = { ...envSnapshot };
    vi.resetModules();
  });

  it('publishes blob-pack transferIds that fit within the direct-peer URL param length budget (no embedded digests)', async () => {
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = String(1024 * 1024 * 1024);
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '256';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = String(1024 * 1024 * 1024);

    vi.resetModules();
    const { publishSessionHandoffWorkspaceReplicationDirectPeerTransfers } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-publication-'));
    try {
      const blobPathsByDigest = new Map<string, string>();
      const blobProviderRoot = join(activeServerDir, 'blob-provider');
      await mkdir(blobProviderRoot, { recursive: true });
      const entries: WorkspaceManifest['entries'] = [];
      for (let i = 0; i < 257; i++) {
        const filePath = join(blobProviderRoot, `${i.toString(16).padStart(4, '0')}.bin`);
        const payload = Buffer.from(`payload-${i}`, 'utf8');
        await writeFile(filePath, payload);
        const digest = createSha256DigestForPayload(payload);
        blobPathsByDigest.set(digest, filePath);
        entries.push({
          kind: 'file',
          relativePath: `files/file-${i}.txt`,
          digest,
          sizeBytes: payload.byteLength,
          executable: false,
        });
      }

      const manifest: WorkspaceManifest = { entries };

      const publishedTransfers: Array<Readonly<{ transferId: string; endpointCandidates: readonly TransferEndpointCandidate[] }>> = [];
      const publishedInputs: Array<Readonly<{ transferId: string; onDemandScope?: unknown }>> = [];
      const directPeerTransfer = {
        publishTransfer: (input: Readonly<{
          transferId: string;
          payload: unknown;
          payloadSource?: unknown;
          onDemandScope?: unknown;
        }>) => {
          const endpointCandidates: readonly TransferEndpointCandidate[] = [{
            kind: 'http',
            url: `http://127.0.0.1:1234/${encodeURIComponent(input.transferId)}`,
            expiresAt: Date.now() + 60_000,
          }];
          publishedTransfers.push({
            transferId: input.transferId,
            endpointCandidates,
          });
          publishedInputs.push({
            transferId: input.transferId,
            onDemandScope: input.onDemandScope,
          });
          return endpointCandidates;
        },
      } as const;

      const result = await publishSessionHandoffWorkspaceReplicationDirectPeerTransfers({
        handoffId: 'handoff-1',
        activeServerDir,
        manifest,
        directPeerTransfer,
        blobProvider: {
          getBlobFilePath: (digest: string) => blobPathsByDigest.get(digest) ?? null,
        },
      });

      // Manifest + blob packs must be file-backed payload sources (no unbounded whole-buffer assembly).
      expect(result.payloadSources.every(({ payloadSource }) => payloadSource.kind === 'file')).toBe(true);

      // Direct-peer publication must not pre-publish blob-pack transfers (no 1-digest-per-transfer loop).
      // Blob packs are served on-demand from the manifest transfer's scoped resolver, aligned with
      // target missing-blob batching.
      expect(publishedTransfers).toHaveLength(1);
      expect(publishedTransfers.some((entry) => entry.transferId.includes(':workspace-manifest'))).toBe(true);
      // Blob packs are resolved on demand (no pre-published blob-pack transfer ids).
      expect(publishedTransfers.some((entry) => entry.transferId.includes(':workspace-pack-direct:'))).toBe(false);
      expect(publishedInputs.some((entry) => String(entry.transferId).includes(':workspace-pack-direct:'))).toBe(false);

      const scopeCarrier = publishedInputs.find((entry) => entry.transferId.includes(':workspace-manifest'));
      expect(scopeCarrier?.onDemandScope).toBeDefined();
      const onDemandScope = scopeCarrier?.onDemandScope as {
        allowTransferId: (transferId: string) => boolean;
        resolvePayloadSourceOnOpen: (input: Readonly<{ transferId: string; requestBody: unknown }>) => Promise<unknown>;
      };

      const packDigests = entries
        .filter((entry) => entry.kind === 'file')
        .slice(0, 2)
        .map((entry) => (entry as { digest: string }).digest)
        .sort((left, right) => left.localeCompare(right));
      const packId = createWorkspaceReplicationPackIdForDigests(packDigests);
      const packTransferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
        handoffId: 'handoff-1',
        packId,
      });

      expect(onDemandScope.allowTransferId(packTransferId)).toBe(true);

      // directPeerTransport encodes transferId into a base64url path param and Fastify caps params at 4k chars.
      const encodedPathKeyLength = Buffer.from(packTransferId, 'utf8').toString('base64url').length;
      expect(encodedPathKeyLength).toBeLessThanOrEqual(4096);

      const resolved = await onDemandScope.resolvePayloadSourceOnOpen({
        transferId: packTransferId,
        requestBody: {
          t: 'workspace_replication_blob_pack_v1',
          packId,
          digests: packDigests,
        },
      });
      expect(resolved).toMatchObject({ kind: 'file' });

      for (const { payloadSource } of result.payloadSources) {
        await disposeTransferPayloadSource(payloadSource);
      }
      await disposeTransferPayloadSource(resolved as any);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('sets maxResolvedTransfers high enough to serve worst-case pack requests for large manifests (no fixed 10k cap)', async () => {
    vi.resetModules();
    const { publishSessionHandoffWorkspaceReplicationDirectPeerTransfers } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-max-resolved-'));
    try {
      const entries: WorkspaceManifest['entries'] = [];
      const digestCount = 12_345;
      for (let i = 0; i < digestCount; i++) {
        entries.push({
          kind: 'file',
          relativePath: `files/file-${i}.txt`,
          digest: `sha256:${i.toString(16).padStart(64, '0')}`,
          sizeBytes: 1,
          executable: false,
        });
      }
      const manifest: WorkspaceManifest = { entries };

      const publishedInputs: Array<Readonly<{ transferId: string; onDemandScope?: unknown }>> = [];
      const directPeerTransfer = {
        publishTransfer: (input: Readonly<{
          transferId: string;
          payload: unknown;
          payloadSource?: unknown;
          onDemandScope?: unknown;
        }>) => {
          publishedInputs.push({
            transferId: input.transferId,
            onDemandScope: input.onDemandScope,
          });
          return [{
            kind: 'http',
            url: `http://127.0.0.1:1234/${encodeURIComponent(input.transferId)}`,
            expiresAt: Date.now() + 60_000,
          }] satisfies readonly TransferEndpointCandidate[];
        },
      } as const;

      const result = await publishSessionHandoffWorkspaceReplicationDirectPeerTransfers({
        handoffId: 'handoff-large-1',
        activeServerDir,
        manifest,
        directPeerTransfer,
        blobProvider: {
          getBlobFilePath: () => null,
        },
      });

      const scopeCarrier = publishedInputs.find((entry) => entry.transferId.includes(':workspace-manifest'));
      expect(scopeCarrier?.onDemandScope).toBeDefined();
      const onDemandScope = scopeCarrier?.onDemandScope as { maxResolvedTransfers?: number };
      expect(onDemandScope.maxResolvedTransfers).toBeGreaterThanOrEqual(digestCount);

      for (const { payloadSource } of result.payloadSources) {
        await disposeTransferPayloadSource(payloadSource);
      }
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
