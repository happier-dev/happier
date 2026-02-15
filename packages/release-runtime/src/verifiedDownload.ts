import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lookupSha256 } from './checksums.js';
import { verifyMinisign } from './minisign.js';

type ReleaseAsset = Readonly<{ name: string; url: string }>;

export type ReleaseAssetBundle = Readonly<{
  version: string;
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
  checksumsSig: ReleaseAsset;
}>;

async function fetchText(url: string, { userAgent = 'happier-release-runtime' } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': userAgent } });
  if (!res.ok) throw new Error(`[download] failed: ${url} (${res.status})`);
  return res.text();
}

async function fetchBytes(url: string, { userAgent = 'happier-release-runtime' } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': userAgent } });
  if (!res.ok) throw new Error(`[download] failed: ${url} (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function downloadVerifiedReleaseAssetBundle(params: Readonly<{
  bundle: ReleaseAssetBundle;
  destDir: string;
  pubkeyFile: string;
  userAgent?: string;
}>): Promise<Readonly<{
  version: string;
  archiveName: string;
  archivePath: string;
  source: { archiveUrl: string; checksumsUrl: string };
}>> {
  const bundle = params.bundle;
  const destDir = String(params.destDir ?? '').trim();
  const pubkeyFile = String(params.pubkeyFile ?? '');
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  if (!destDir) throw new Error('[download] destDir is required');
  if (!pubkeyFile.trim()) throw new Error('[download] pubkeyFile is required');

  await mkdir(destDir, { recursive: true });

  const checksumsText = await fetchText(bundle.checksums.url, { userAgent });
  const sigFile = await fetchText(bundle.checksumsSig.url, { userAgent });
  const ok = verifyMinisign({ message: Buffer.from(checksumsText, 'utf-8'), pubkeyFile, sigFile });
  if (!ok) {
    throw new Error('[download] signature verification failed for checksums file');
  }

  const expected = lookupSha256({ checksumsText, filename: bundle.archive.name });
  const bytes = await fetchBytes(bundle.archive.url, { userAgent });
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`[download] checksum verification failed for ${bundle.archive.name}`);
  }

  const archivePath = join(destDir, bundle.archive.name);
  await writeFile(archivePath, bytes);
  return {
    version: String(bundle.version ?? ''),
    archiveName: bundle.archive.name,
    archivePath,
    source: { archiveUrl: bundle.archive.url, checksumsUrl: bundle.checksums.url },
  };
}

