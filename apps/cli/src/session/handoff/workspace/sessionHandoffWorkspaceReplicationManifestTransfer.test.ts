import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

import {
  WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC,
  createSessionHandoffWorkspaceReplicationManifestPayloadSource,
  readSessionHandoffWorkspaceReplicationManifestFromFile,
} from './sessionHandoffWorkspaceReplicationManifestTransfer';

describe('sessionHandoffWorkspaceReplicationManifestTransfer', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('writes the manifest in the streaming manifest file format and can read it back', async () => {
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const source = await createSessionHandoffWorkspaceReplicationManifestPayloadSource({
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

      const manifest = await readSessionHandoffWorkspaceReplicationManifestFromFile({
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

  it('rejects legacy JSON manifest files (streaming-only; no undeployed compatibility)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-session-handoff-manifest-legacy-'));
    const filePath = join(directory, 'workspace-manifest.json');

    try {
      await writeFile(filePath, `{\"entries\": []}`, 'utf8');

      await expect(readSessionHandoffWorkspaceReplicationManifestFromFile({
        transferId: 'transfer_legacy',
        filePath,
      })).rejects.toThrow(/Legacy workspace replication manifest format is not supported/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
