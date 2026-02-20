import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import * as tar from 'tar';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';

type RawAsset = Readonly<{ name?: unknown; browser_download_url?: unknown }>;

export type ReleaseAsset = Readonly<{ name: string; url: string }>;

export type ReleaseAssetBundle = Readonly<{
  version: string;
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
  checksumsSig: ReleaseAsset;
}>;

function normalizeAsset(asset: RawAsset): ReleaseAsset | null {
  const name = String(asset?.name ?? '').trim();
  const url = String(asset?.browser_download_url ?? '').trim();
  if (!name || !url) return null;
  return { name, url };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inferVersionFromArchiveName(params: Readonly<{ archiveName: string; os: string; arch: string }>): string | null {
  const suffix = `-${params.os}-${params.arch}.tar.gz`;
  const name = String(params.archiveName ?? '').trim();
  if (!name.startsWith('happier-v')) return null;
  if (!name.endsWith(suffix)) return null;
  const v = name.slice('happier-v'.length, name.length - suffix.length);
  return v || null;
}

export function resolveCliBinaryAssetBundleFromReleaseAssets(params: Readonly<{
  assets: unknown;
  os: string;
  arch: string;
  preferVersion: string | null;
}>): ReleaseAssetBundle {
  const os = String(params.os ?? '').trim();
  const arch = String(params.arch ?? '').trim();
  if (!os) throw new Error('os is required');
  if (!arch) throw new Error('arch is required');

  const preferVersion = String(params.preferVersion ?? '').trim() || null;
  const list = Array.isArray(params.assets) ? (params.assets as RawAsset[]) : [];

  const desiredArchiveName = preferVersion ? `happier-v${preferVersion}-${os}-${arch}.tar.gz` : null;
  const archiveRe = new RegExp(`^happier-v.+-${os}-${arch}\\.tar\\.gz$`);

  let selectedArchive: ReleaseAsset | null = null;
  for (const asset of list) {
    const a = normalizeAsset(asset);
    if (!a) continue;
    if (desiredArchiveName) {
      if (a.name === desiredArchiveName) selectedArchive = a;
      continue;
    }
    if (archiveRe.test(a.name)) {
      selectedArchive = a; // last match wins (rolling tags)
    }
  }
  if (!selectedArchive) {
    throw new Error(`missing CLI archive for ${os}-${arch}`);
  }

  const version = inferVersionFromArchiveName({ archiveName: selectedArchive.name, os, arch });
  if (!version) {
    throw new Error(`failed to infer version from archive name: ${selectedArchive.name}`);
  }

  const checksumsName = `checksums-happier-v${version}.txt`;
  const sigName = `${checksumsName}.minisig`;

  let checksums: ReleaseAsset | null = null;
  let checksumsSig: ReleaseAsset | null = null;
  for (const asset of list) {
    const a = normalizeAsset(asset);
    if (!a) continue;
    if (a.name === checksumsName) checksums = a;
    if (a.name === sigName) checksumsSig = a;
  }
  if (!checksums) throw new Error(`missing release asset: ${checksumsName}`);
  if (!checksumsSig) throw new Error(`missing release asset: ${sigName}`);

  return {
    version,
    archive: selectedArchive,
    checksums,
    checksumsSig,
  };
}

async function resolveWritableBinaryTarget(execPath: string): Promise<string> {
  const raw = String(execPath ?? '').trim();
  if (!raw) throw new Error('execPath is required');
  const st = await lstat(raw).catch(() => null);
  if (!st) throw new Error(`binary path does not exist: ${raw}`);
  if (st.isSymbolicLink()) {
    const resolved = await realpath(raw);
    return resolved;
  }
  return raw;
}

async function replaceFileAtomic(params: Readonly<{ targetPath: string; bytes: Buffer; mode: number }>): Promise<void> {
  const dir = dirname(params.targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(params.targetPath)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmpPath, params.bytes, { mode: params.mode });
  await rename(tmpPath, params.targetPath);
}

async function extractBinaryFromArchive(params: Readonly<{ archivePath: string; archiveName: string; extractDir: string }>): Promise<string> {
  await mkdir(params.extractDir, { recursive: true });
  await tar.x({
    file: params.archivePath,
    cwd: params.extractDir,
  });
  const stem = params.archiveName.replace(/\.tar\.gz$/i, '');
  const candidate = join(params.extractDir, stem, 'happier');
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`extracted binary not found at expected path: ${candidate}`);
  }
  return candidate;
}

export async function updateBinaryFromReleaseAssets(params: Readonly<{
  assets: unknown;
  os: string;
  arch: string;
  execPath: string;
  minisignPubkeyFile?: string;
  preferVersion: string | null;
}>): Promise<Readonly<{ updatedTo: string; updatedPath: string }>> {
  const bundle = resolveCliBinaryAssetBundleFromReleaseAssets({
    assets: params.assets,
    os: params.os,
    arch: params.arch,
    preferVersion: params.preferVersion,
  });

  const pubkeyFile = String(params.minisignPubkeyFile ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY;
  const scratchRoot = await mkdtemp(join(tmpdir(), 'happier-self-update-'));
  try {
    const downloadDir = join(scratchRoot, 'download');
    const extractDir = join(scratchRoot, 'extract');
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: downloadDir,
      pubkeyFile,
      userAgent: 'happier-cli',
    });

    const extractedBinaryPath = await extractBinaryFromArchive({
      archivePath: downloaded.archivePath,
      archiveName: downloaded.archiveName,
      extractDir,
    });

    const bytes = await readFile(extractedBinaryPath);
    const targetPath = await resolveWritableBinaryTarget(params.execPath);
    await replaceFileAtomic({ targetPath, bytes, mode: 0o755 });
    return { updatedTo: bundle.version, updatedPath: targetPath };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

export async function updateCliBinaryFromGitHubTag(params: Readonly<{
  githubRepo: string;
  tag: string;
  githubToken?: string;
  os: string;
  arch: string;
  execPath: string;
  preferVersion: string | null;
  minisignPubkeyFile?: string;
}>): Promise<Readonly<{ updatedTo: string; updatedPath: string }>> {
  const release = await fetchGitHubReleaseByTag({
    githubRepo: params.githubRepo,
    tag: params.tag,
    githubToken: String(params.githubToken ?? '').trim(),
    userAgent: 'happier-cli',
  });
  const assets = typeof release === 'object' && release != null && 'assets' in release ? (release as any).assets : null;
  return updateBinaryFromReleaseAssets({
    assets,
    os: params.os,
    arch: params.arch,
    execPath: params.execPath,
    preferVersion: params.preferVersion,
    minisignPubkeyFile: params.minisignPubkeyFile,
  });
}
