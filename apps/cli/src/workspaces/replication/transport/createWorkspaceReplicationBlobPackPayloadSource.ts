import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileTransferPayloadSource,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import { WorkspaceReplicationError } from '../workspaceReplicationError';
import {
  createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
  createWorkspaceReplicationBlobPackEndMarkerBuffer,
  createWorkspaceReplicationBlobPackHeaderBuffer,
} from './workspaceReplicationBlobPackFormatV1';
import { assertSafeWorkspaceReplicationPackId } from './workspaceReplicationPackId';

async function writeBufferPart(input: Readonly<{
  file: Awaited<ReturnType<typeof open>>;
  hash: ReturnType<typeof createHash>;
  buffer: Buffer;
}>): Promise<number> {
  await input.file.write(input.buffer);
  input.hash.update(input.buffer);
  return input.buffer.byteLength;
}

export async function createWorkspaceReplicationBlobPackPayloadSource(input: Readonly<{
  activeServerDir: string;
  packId: string;
  digests: readonly string[];
}>): Promise<TransferPayloadSource> {
  const packId = assertSafeWorkspaceReplicationPackId(input.packId);
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const tempDirectory = join(tmpdir(), 'happier-workspace-replication-blob-packs');
  await mkdir(tempDirectory, { recursive: true });
  const filePath = join(tempDirectory, `${packId}-${randomUUID()}.bin`);
  const file = await open(filePath, 'w');
  const hash = createHash('sha256');
  let sizeBytes = 0;

  try {
    sizeBytes += await writeBufferPart({
      file,
      hash,
      buffer: createWorkspaceReplicationBlobPackHeaderBuffer(),
    });

    for (const digest of input.digests) {
      const blobPath = casStore.resolveBlobPath(digest);
      const blobStats = await stat(blobPath).catch((error: unknown) => {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
        if (code === 'ENOENT') {
          throw new WorkspaceReplicationError({
            code: 'missing_cas_blob',
            message: `Missing workspace replication CAS blob: ${digest}`,
            cause: error,
          });
        }
        throw error;
      });
      sizeBytes += await writeBufferPart({
        file,
        hash,
        buffer: createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
          digest,
          sizeBytes: blobStats.size,
        }),
      });

      const stream = casStore.openReadStream(digest);
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += await writeBufferPart({
          file,
          hash,
          buffer,
        });
      }
    }

    sizeBytes += await writeBufferPart({
      file,
      hash,
      buffer: createWorkspaceReplicationBlobPackEndMarkerBuffer(),
    });
  } catch (error) {
    await file.close();
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }

  await file.close();

  return createFileTransferPayloadSource({
    filePath,
    sizeBytes,
    manifestHash: `sha256:${hash.digest('hex')}`,
    dispose: async () => {
      await rm(filePath, { force: true }).catch(() => undefined);
    },
  });
}
