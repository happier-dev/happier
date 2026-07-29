import type { ModelPackManifest } from '@happier-dev/protocol';

import { createSha256Hasher } from './sha256.js';
import { deriveModelPackStagingPlan } from './installerCore.js';

export type InstalledModelPackIntegrityHost = Readonly<{
  streamFile(
    packId: string,
    filePath: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<number>;
}>;

export class InstalledModelPackIntegrityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'InstalledModelPackIntegrityError';
  }
}

/** Re-verify immutable installed bytes before a new runtime may reclaim them. */
export async function verifyInstalledModelPackWithHost(params: Readonly<{
  host: InstalledModelPackIntegrityHost;
  packId: string;
  expectedManifest: ModelPackManifest;
  actualManifest: ModelPackManifest;
}>): Promise<void> {
  if (
    params.expectedManifest.packId !== params.packId
    || params.actualManifest.packId !== params.packId
    || deriveModelPackStagingPlan(params.actualManifest).key !== deriveModelPackStagingPlan(params.expectedManifest).key
  ) {
    throw new InstalledModelPackIntegrityError('model_pack_installed_manifest_mismatch');
  }

  for (const file of params.expectedManifest.files) {
    const hasher = createSha256Hasher();
    let streamed = 0;
    let reported: number;
    try {
      reported = await params.host.streamFile(params.packId, file.path, (chunk) => {
        streamed += chunk.byteLength;
        if (streamed > file.sizeBytes) {
          throw new InstalledModelPackIntegrityError('model_pack_installed_size_mismatch');
        }
        hasher.update(chunk);
      });
    } catch (error) {
      if (error instanceof InstalledModelPackIntegrityError) throw error;
      throw new InstalledModelPackIntegrityError('model_pack_installed_file_unreadable');
    }
    if (reported !== streamed || streamed !== file.sizeBytes) {
      throw new InstalledModelPackIntegrityError('model_pack_installed_size_mismatch');
    }
    if ((await hasher.digestHex()) !== file.sha256.toLowerCase()) {
      throw new InstalledModelPackIntegrityError('model_pack_installed_sha256_mismatch');
    }
  }
}
