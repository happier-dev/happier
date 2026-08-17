import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const fileDigestCache = new Map();

function metadataIdentity(stats) {
  return `${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}`;
}

function metadataFallback(identity) {
  return `metadata:${identity}`;
}

export function forgetCachedFileDigest(path) {
  fileDigestCache.delete(path);
}

export function readCachedFileDigestSync(path, stats) {
  const identity = metadataIdentity(stats);
  const cached = fileDigestCache.get(path);
  if (cached?.identity === identity) return cached.digest;
  try {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    fileDigestCache.set(path, { identity, digest });
    return digest;
  } catch {
    return metadataFallback(identity);
  }
}

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
