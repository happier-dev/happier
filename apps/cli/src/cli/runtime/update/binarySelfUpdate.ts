import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  extractReleasePayloadRootFromArchive,
  installVersionedPayload,
  resolveCliBinaryAssetBundleFromReleaseAssets,
  resolveFirstPartyInstallLayout,
} from '@happier-dev/cli-common/firstPartyRuntime';
export {
  resolveCliBinaryAssetBundleFromReleaseAssets,
} from '@happier-dev/cli-common/firstPartyRuntime';
export type {
  ReleaseAsset,
  ReleaseAssetBundle,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';

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
  const payloadRoot = await extractReleasePayloadRootFromArchive({
    archivePath: params.archivePath,
    archiveName: params.archiveName,
    extractDir: params.extractDir,
  });
  const candidate = join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier');
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

export async function updateInstalledCliPayloadFromReleaseAssets(params: Readonly<{
  assets: unknown;
  os: string;
  arch: string;
  happyHomeDir: string;
  minisignPubkeyFile?: string;
  preferVersion: string | null;
  channel?: PublicReleaseRingId;
}>): Promise<Readonly<{
  updatedTo: string;
  installRoot: string;
  previousVersionId: string | null;
  hadLegacyCurrentInstallWithoutVersionMarkers: boolean;
}>> {
  const bundle = resolveCliBinaryAssetBundleFromReleaseAssets({
    assets: params.assets,
    os: params.os,
    arch: params.arch,
    preferVersion: params.preferVersion,
  });

  const pubkeyFile = String(params.minisignPubkeyFile ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY;
  const scratchRoot = await mkdtemp(join(tmpdir(), 'happier-self-update-'));
  const processEnv = { ...process.env, HAPPIER_HOME_DIR: params.happyHomeDir };

  try {
    const downloadDir = join(scratchRoot, 'download');
    const extractDir = join(scratchRoot, 'extract');
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: downloadDir,
      pubkeyFile,
      userAgent: 'happier-cli',
    });

    const payloadRoot = await extractReleasePayloadRootFromArchive({
      archivePath: downloaded.archivePath,
      archiveName: downloaded.archiveName,
      extractDir,
    });

    const promotion = await installVersionedPayload({
      componentId: 'happier-cli',
      versionId: bundle.version,
      payloadRoot,
      payloadRootAlreadyFiltered: true,
      channel: params.channel,
      processEnv,
    });

    return {
      updatedTo: bundle.version,
      installRoot: resolveFirstPartyInstallLayout({
        componentId: 'happier-cli',
        channel: params.channel,
        processEnv,
      }).installRoot,
      previousVersionId: promotion.previousVersionId,
      hadLegacyCurrentInstallWithoutVersionMarkers: promotion.hadLegacyCurrentInstallWithoutVersionMarkers,
    };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}
