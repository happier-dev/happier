import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

import {
  WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC,
  createWorkspaceReplicationManifestPayloadSource,
  readWorkspaceReplicationManifestDigestIndexFromFile,
  readWorkspaceReplicationManifestFromFile,
} from './workspaceReplicationManifestTransferV1';

describe('workspaceReplicationManifestTransferV1', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('writes the manifest in the streaming manifest file format and can read it back', async () => {
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const source = await createWorkspaceReplicationManifestPayloadSource({
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest,
            sizeBytes: 6,
            executable: false,
          },
          {
            relativePath: 'src',
            kind: 'directory',
          },
        ],
        fingerprint,
      },
    });

    try {
      expect(source.kind).toBe('file');
      if (source.kind !== 'file') {
        throw new Error('Expected file payload source');
      }
      const firstLine = (await readFile(source.filePath, 'utf8')).split('\n')[0]!.trim();
      expect(firstLine).toBe(WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC);

      const manifest = await readWorkspaceReplicationManifestFromFile({
        transferId: 'transfer_1',
        filePath: source.filePath,
      });
      expect(manifest.fingerprint).toBe(fingerprint);
      expect(manifest.entries).toHaveLength(2);
      expect(manifest.entries[0]).toMatchObject({
        kind: 'file',
        relativePath: 'README.md',
      });
    } finally {
      await disposeTransferPayloadSource(source);
    }
  });

  it('can read a digest index from the streaming manifest file without requiring a full manifest object', async () => {
    const digest1 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const digest2 = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const source = await createWorkspaceReplicationManifestPayloadSource({
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: digest1,
            sizeBytes: 6,
            executable: false,
          },
          {
            relativePath: 'src/main.ts',
            kind: 'file',
            digest: digest2,
            sizeBytes: 10,
            executable: true,
          },
          {
            relativePath: 'src',
            kind: 'directory',
          },
        ],
      },
    });

    try {
      expect(source.kind).toBe('file');
      if (source.kind !== 'file') {
        throw new Error('Expected file payload source');
      }

      const index = await readWorkspaceReplicationManifestDigestIndexFromFile({
        transferId: 'transfer_digest_index_1',
        filePath: source.filePath,
        sizeBytes: source.sizeBytes,
      });

      expect(index.get(digest1)).toEqual({ relativePath: 'README.md', sizeBytes: 6 });
      expect(index.get(digest2)).toEqual({ relativePath: 'src/main.ts', sizeBytes: 10 });
      expect(index.size).toBe(2);
    } finally {
      await disposeTransferPayloadSource(source);
    }
  });

  it('rejects non-streaming manifest files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-manifest-legacy-'));
    const filePath = join(directory, 'workspace-manifest.json');

    try {
      await writeFile(filePath, `{\"entries\": []}`, 'utf8');

      await expect(readWorkspaceReplicationManifestFromFile({
        transferId: 'transfer_legacy',
        filePath,
      })).rejects.toThrow(/Invalid workspace replication manifest/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when sizeBytes is provided but does not match the actual manifest file', async () => {
    const source = await createWorkspaceReplicationManifestPayloadSource({
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            sizeBytes: 1,
            executable: false,
          },
        ],
      },
    });

    try {
      expect(source.kind).toBe('file');
      if (source.kind !== 'file') {
        throw new Error('Expected file payload source');
      }

      const actualSizeBytes = source.sizeBytes ?? (await stat(source.filePath)).size;
      await expect(readWorkspaceReplicationManifestFromFile({
        transferId: 'transfer_1',
        filePath: source.filePath,
        sizeBytes: actualSizeBytes + 1,
      })).rejects.toThrow(/Invalid workspace replication manifest/u);
    } finally {
      await disposeTransferPayloadSource(source);
    }
  });
});
