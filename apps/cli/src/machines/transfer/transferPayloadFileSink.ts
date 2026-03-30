import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

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
      hash.update(chunk);
      await fileHandle.write(chunk, 0, chunk.length, sizeBytes);
      sizeBytes += chunk.length;
    },
    async finalize(expectedManifestHash) {
      try {
        await closeFileHandle(fileHandle);
        const manifestHash = `sha256:${hash.digest('hex')}`;
        if (manifestHash !== expectedManifestHash) {
          throw new Error(`Transfer payload manifest mismatch for ${input.destinationPath}`);
        }
        await rename(temporaryPath, input.destinationPath);
        return {
          destinationPath: input.destinationPath,
          manifestHash,
          sizeBytes,
        };
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    },
    async abort() {
      await closeFileHandle(fileHandle).catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    },
  };
}
