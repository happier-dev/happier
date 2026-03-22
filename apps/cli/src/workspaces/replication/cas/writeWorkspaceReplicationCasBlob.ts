import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type WriteWorkspaceReplicationCasBlobResult = Readonly<{
  digest: string;
  blobPath: string;
  sizeBytes: number;
}>;

export async function writeWorkspaceReplicationCasBlob(input: Readonly<{
  digest: string;
  sourcePath: string;
  blobPath: string;
}>): Promise<WriteWorkspaceReplicationCasBlobResult> {
  await mkdir(dirname(input.blobPath), { recursive: true });
  const temporaryPath = join(dirname(input.blobPath), `${randomUUID()}.part`);

  try {
    const { digest, sizeBytes } = await copyFileWithDigestVerification({
      sourcePath: input.sourcePath,
      destinationPath: temporaryPath,
    });
    if (digest !== input.digest) {
      throw new Error(`Workspace replication CAS digest mismatch for ${input.sourcePath}`);
    }

    await rename(temporaryPath, input.blobPath).catch(async (error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') {
        throw error;
      }
    });

    return {
      digest,
      blobPath: input.blobPath,
      sizeBytes,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function copyFileWithDigestVerification(input: Readonly<{
  sourcePath: string;
  destinationPath: string;
}>): Promise<Readonly<{ digest: string; sizeBytes: number }>> {
  const hash = createHash('sha256');
  let sizeBytes = 0;

  await mkdir(dirname(input.destinationPath), { recursive: true });

  await pipeline(
    createReadStream(input.sourcePath),
    new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        sizeBytes += buffer.length;
        callback(null, buffer);
      },
    }),
    createWriteStream(input.destinationPath, { mode: 0o600 }),
  );

  return {
    digest: `sha256:${hash.digest('hex')}`,
    sizeBytes,
  };
}
