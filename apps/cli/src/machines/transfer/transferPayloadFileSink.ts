import { readTransferPayloadChunk, resolveTransferPayloadManifestHash, resolveTransferPayloadSizeBytes, type TransferPayloadSource } from './transferPayloadSource';
import { resolveDirectPeerTransferChunkBytes } from './transferRuntimeConfig';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  CrossDeviceMoveSourceCleanupError,
  moveFileWithCrossDeviceFallback,
} from '@/utils/fs/moveFileWithCrossDeviceFallback';
import { writeFileHandleFully } from '@happier-dev/transfers/node';

export type TransferPayloadFileResult = Readonly<{
  destinationPath: string;
  manifestHash: string;
  sizeBytes: number;
}>;

export type TransferPayloadFileSink = Readonly<{
  appendChunk: (chunk: Buffer) => Promise<void>;
  finalize: (expectedManifestHash: string) => Promise<TransferPayloadFileResult>;
  abort: () => Promise<void>;
}>;

export async function createTransferPayloadFileSink(input: Readonly<{
  destinationPath: string;
}>): Promise<TransferPayloadFileSink> {
  await mkdir(dirname(input.destinationPath), { recursive: true });
  const temporaryPath = `${input.destinationPath}.${randomUUID()}.part`;
  const fileHandle = await open(temporaryPath, 'w', 0o600);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let isClosed = false;

  async function closeFileHandle(handle: FileHandle): Promise<void> {
    if (isClosed) {
      return;
    }
    isClosed = true;
    await handle.close();
  }

  return {
    async appendChunk(chunk) {
      if (isClosed) {
        throw new Error(`Transfer payload sink already closed for ${input.destinationPath}`);
      }
      await writeFileHandleFully({
        fileHandle,
        buffer: chunk,
        position: sizeBytes,
      });
      hash.update(chunk);
      sizeBytes += chunk.length;
    },
    async finalize(expectedManifestHash) {
      try {
        await closeFileHandle(fileHandle);
        const manifestHash = `sha256:${hash.digest('hex')}`;
        if (manifestHash !== expectedManifestHash) {
          throw new Error(`Transfer payload manifest mismatch for ${input.destinationPath}`);
        }
        const destinationStats = await stat(input.destinationPath).catch((error: unknown) => {
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : null;
          if (code === 'ENOENT') {
            return null;
          }
          throw error;
        });
        if (destinationStats?.isDirectory()) {
          throw new Error(`Transfer payload destination is a directory: ${input.destinationPath}`);
        }
        await moveFileWithCrossDeviceFallback(temporaryPath, input.destinationPath);
        return {
          destinationPath: input.destinationPath,
          manifestHash,
          sizeBytes,
        };
      } catch (error) {
        if (!(error instanceof CrossDeviceMoveSourceCleanupError)) {
          await rm(temporaryPath, { force: true }).catch(() => {});
        }
        throw error;
      }
    },
    async abort() {
      await closeFileHandle(fileHandle).catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    },
  };
}

export async function writeTransferPayloadSourceToFile(input: Readonly<{
  source: TransferPayloadSource; destinationPath: string;
}>): Promise<TransferPayloadFileResult> {
  const sizeBytes = await resolveTransferPayloadSizeBytes(input.source);
  const manifestHash = await resolveTransferPayloadManifestHash(input.source);
  const sink = await createTransferPayloadFileSink({ destinationPath: input.destinationPath });
  try {
    let offset = 0;
    const chunkSizeBytes = resolveDirectPeerTransferChunkBytes();
    while (offset < sizeBytes) {
      const bytes = await readTransferPayloadChunk({ source: input.source, offset,
        length: Math.min(chunkSizeBytes, sizeBytes - offset) });
      if (bytes.length === 0) throw new Error('Transfer source ended before its admitted size');
      await sink.appendChunk(bytes);
      offset += bytes.length;
    }
    return await sink.finalize(manifestHash);
  } catch (error) { await sink.abort(); throw error; }
}
