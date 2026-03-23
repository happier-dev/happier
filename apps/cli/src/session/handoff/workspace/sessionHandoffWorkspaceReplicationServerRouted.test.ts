import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC } from '@/workspaces/replication/transport/workspaceReplicationSourceOfferFileFormat';
import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

describe('sessionHandoffWorkspaceReplicationServerRouted', () => {
  it('writes source offer payloads in the streaming source-offer file format (no whole-buffer JSON)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-offer-'));

    try {
      const { createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource } = await import(
        './sessionHandoffWorkspaceReplicationServerRouted'
      );

      const source = await createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource({
        activeServerDir,
        sourceMachineId: 'source-1',
        targetMachineId: 'target-1',
        targetPath: '/target',
        metadata: {
          sourceRootPath: '/source',
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:readme',
                sizeBytes: 6,
                executable: false,
              },
              {
                relativePath: 'src/index.ts',
                kind: 'file',
                digest: 'sha256:index',
                sizeBytes: 10,
                executable: false,
              },
            ],
          },
        },
      });

      try {
        expect(source.kind).toBe('file');
        if (source.kind !== 'file') {
          throw new Error('Expected file payload source');
        }
        const firstLine = (await readFile(source.filePath, 'utf8')).split('\n')[0]!.trim();
        expect(firstLine).toBe(WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC);
      } finally {
        await disposeTransferPayloadSource(source);
      }
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
