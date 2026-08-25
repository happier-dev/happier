import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { computeSha256ForPath } from './checksum.mjs';

export async function downloadPinnedGhosttyKitArchive({
  sourceUrl,
  destinationPath,
  expectedSha256,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Pinned GhosttyKit download requires fetch support.');
  }
  if (!sourceUrl || !destinationPath || !expectedSha256) {
    throw new Error('Pinned GhosttyKit download requires sourceUrl, destinationPath, and expectedSha256.');
  }

  const response = await fetchImpl(sourceUrl);
  if (!response.ok) {
    throw new Error(`Pinned GhosttyKit download failed with HTTP ${response.status}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, bytes);

  try {
    const checksum = await computeSha256ForPath(destinationPath);
    if (checksum !== expectedSha256) {
      throw new Error(
        `Pinned GhosttyKit checksum mismatch: expected ${expectedSha256}, received ${checksum}.`,
      );
    }
    return { checksum: { sha256: checksum } };
  } catch (error) {
    await rm(destinationPath, { force: true });
    throw error;
  }
}
