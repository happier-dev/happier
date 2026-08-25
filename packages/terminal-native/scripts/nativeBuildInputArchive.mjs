import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

import { computeSha256ForPath } from './checksum.mjs';

/**
 * Download a pinned native build-input archive into a checksum-verified cache.
 * The cache path is replaced only after the newly downloaded bytes pass the
 * requested checksum, so a failed refresh never promotes unverified bytes.
 */
export async function ensurePinnedNativeBuildInputArchive({
  sourceUrl,
  expectedSha256,
  cacheRoot,
  cacheKey,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedSourceUrl = String(sourceUrl ?? '').trim();
  const normalizedExpectedSha256 = String(expectedSha256 ?? '').trim().toLowerCase();
  const rawCacheRoot = String(cacheRoot ?? '').trim();
  const normalizedCacheKey = String(cacheKey ?? '').trim();

  if (!normalizedSourceUrl || !/^https:\/\//.test(normalizedSourceUrl)) {
    throw new Error('Pinned native build-input archive requires an HTTPS source URL.');
  }
  if (!/^[a-f0-9]{64}$/.test(normalizedExpectedSha256)) {
    throw new Error('Pinned native build-input archive requires a 64-character SHA-256 checksum.');
  }
  if (!rawCacheRoot || !normalizedCacheKey) {
    throw new Error('Pinned native build-input archive requires cacheRoot and cacheKey.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Pinned native build-input archive requires fetch support.');
  }

  const normalizedCacheRoot = resolve(rawCacheRoot);
  const cachePath = resolve(normalizedCacheRoot, normalizedCacheKey);
  if (cachePath !== normalizedCacheRoot && !cachePath.startsWith(`${normalizedCacheRoot}${sep}`)) {
    throw new Error('Pinned native build-input archive cacheKey must stay inside cacheRoot.');
  }

  const cachedChecksum = await readMatchingChecksum(cachePath, normalizedExpectedSha256);
  if (cachedChecksum != null) {
    return {
      status: 'hit',
      path: cachePath,
      checksum: { sha256: cachedChecksum },
    };
  }

  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = resolve(
    dirname(cachePath),
    `.${basename(cachePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    const response = await fetchImpl(normalizedSourceUrl);
    if (!response?.ok) {
      throw new Error(`Pinned native build-input archive download failed with HTTP ${response?.status ?? 'unknown'}.`);
    }

    await writeFile(temporaryPath, new Uint8Array(await response.arrayBuffer()));
    const receivedSha256 = await computeSha256ForPath(temporaryPath);
    if (receivedSha256 !== normalizedExpectedSha256) {
      throw new Error(
        `Pinned native build-input archive checksum mismatch: expected ${normalizedExpectedSha256}, received ${receivedSha256}.`,
      );
    }

    await replaceCachedFile(temporaryPath, cachePath);
    return {
      status: 'downloaded',
      path: cachePath,
      checksum: { sha256: receivedSha256 },
    };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readMatchingChecksum(path, expectedSha256) {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) return null;
    const actualSha256 = await computeSha256ForPath(path);
    return actualSha256 === expectedSha256 ? actualSha256 : null;
  } catch {
    return null;
  }
}

async function replaceCachedFile(temporaryPath, cachePath) {
  try {
    await rename(temporaryPath, cachePath);
  } catch (error) {
    // Windows does not replace an existing file with rename(). The cache is
    // disposable; only the verified temporary file is ever promoted.
    if (!['EACCES', 'EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await rm(cachePath, { force: true });
    await rename(temporaryPath, cachePath);
  }
}
