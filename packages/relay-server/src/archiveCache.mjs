import { mkdir, rm } from 'node:fs/promises';

import { extractFirstPartyReleaseArchiveToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

export async function extractReleaseArchiveIntoCache({ archiveName, archivePath, cacheDir }) {
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  try {
    await extractFirstPartyReleaseArchiveToDirectory({
      archiveName,
      archivePath,
      extractDir: cacheDir,
    });
  } catch (error) {
    try {
      await rm(cacheDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `[relay-server] archive extraction failed and partial cache cleanup also failed: ${cacheDir}`,
      );
    }
    throw error;
  }
}
