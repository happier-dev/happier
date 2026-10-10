import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** @typedef {{ size: number | bigint | string, mtimeNs: number | bigint | string, ctimeNs: number | bigint | string, dev: number | bigint | string, ino: number | bigint | string }} FileDigestMetadata */
/** @type {Map<string, { identity: string, digest: string }>} */
const fileDigestCache = new Map();

/** @param {FileDigestMetadata} stats */
function metadataIdentity(stats) {
  return `${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.dev}\0${stats.ino}`;
}

/** @param {string} identity */
function metadataFallback(identity) {
  return `metadata:${identity}`;
}

/** @param {string} path */
export function forgetCachedFileDigest(path) {
  fileDigestCache.delete(path);
}

/**
 * @param {string} path
 * @param {FileDigestMetadata} stats
 * @param {{ cache?: Map<string, { identity?: unknown, digest?: unknown }> }} options
 */
export function readCachedFileDigestSync(path, stats, { cache = fileDigestCache } = {}) {
  const identity = metadataIdentity(stats);
  const cached = cache.get(path);
  if (cached?.identity === identity && typeof cached.digest === 'string' && /^[0-9a-f]{64}$/u.test(cached.digest)) return cached.digest;
  try {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    cache.set(path, { identity, digest });
    return digest;
  } catch {
    return metadataFallback(identity);
  }
}

/** @param {string} path @param {FileDigestMetadata} stats */
export async function readCachedFileDigest(path, stats) {
  const identity = metadataIdentity(stats);
  const cached = fileDigestCache.get(path);
  if (cached?.identity === identity) return cached.digest;
  try {
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    fileDigestCache.set(path, { identity, digest });
    return digest;
  } catch {
    return metadataFallback(identity);
  }
}
