import { describe, expect, it } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readWorkspaceReplicationSourceOfferFromFile,
  WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC,
  writeWorkspaceReplicationSourceOfferToFile,
} from './workspaceReplicationSourceOfferFileFormat';

describe('workspaceReplicationSourceOfferFileFormat', () => {
  it('roundtrips a source offer through the streaming file format without whole-buffer JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const offer = {
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: `sha256:${'a'.repeat(64)}`,
        manifest: {
          entries: [
            { relativePath: 'src', kind: 'directory' as const },
            {
              relativePath: 'src/a.ts',
              kind: 'file' as const,
              digest: `sha256:${'b'.repeat(64)}`,
              sizeBytes: 1,
              executable: false,
            },
          ],
          fingerprint: `sha256:${'c'.repeat(64)}`,
        },
        blobIndex: [{ digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 1 }],
        sourceControllerMetadata: { scm: 'git' },
      };

      await writeWorkspaceReplicationSourceOfferToFile({ offer: offer as any, filePath });

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).resolves.toMatchObject({
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: offer.sourceFingerprint,
        sourceControllerMetadata: { scm: 'git' },
        manifest: {
          fingerprint: offer.manifest.fingerprint,
        },
        blobIndex: [{ digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 1 }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the streaming magic line is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      await writeFile(filePath, `not-magic\n{}\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow(/legacy/i);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the header line is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      await writeFile(filePath, `${WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC}\nnot-json\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow('Invalid workspace replication source offer');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when an entry line does not match the manifest entry schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const header = JSON.stringify({
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      });
      const badEntry = JSON.stringify({
        // Absolute paths are rejected by WorkspaceManifestEntrySchema.
        relativePath: '/etc/passwd',
        kind: 'file',
        digest: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 1,
        executable: false,
      });
      await writeFile(filePath, `${WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC}\n${header}\n${badEntry}\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow('Invalid workspace replication source offer');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
