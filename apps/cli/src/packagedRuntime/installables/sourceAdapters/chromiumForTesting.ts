import { access, chmod, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join } from 'node:path';

import {
  CHROMIUM_FOR_TESTING_PRODUCT_SOURCE,
  resolveChromiumForTestingPlatform,
  type ChromiumForTestingPlatformAsset,
} from '@happier-dev/protocol';
import {
  createManagedToolScratchDir,
  downloadGitHubReleaseAsset,
  promoteManagedCurrentInstall,
} from '@happier-dev/cli-common/agents';
import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';

import { configuration } from '@/configuration';

/**
 * Binary-safe installer/unpacker for the pinned managed Chrome-for-Testing source (FP-BRW-SOURCE-1).
 *
 * Mirrors the canonical `githubReleaseBinary.ts` install shape: digest-verified download BEFORE
 * unpack, same-volume per-call scratch extraction, atomic candidate -> `current` rename, managed dir under
 * `<happyHomeDir>/tools/<key>`. It NEVER spawns a package manager. It refuses to promote any
 * artifact unless the pinned descriptor carries a real verified digest — the external-artifact
 * remainder (the hosted archive bytes + their real sha256) keeps the product source fail-closed
 * until a verified digest is recorded in the protocol descriptor.
 */

const MANAGED_KEY = CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.key;

export type InstallChromiumForTestingResult =
  | Readonly<{ ok: true; executablePath: string; pinnedVersion: string; integrityDigest: string }>
  | Readonly<{ ok: false; errorMessage: string }>;

function managedInstallDir(): string {
  return join(configuration.happyHomeDir, 'tools', MANAGED_KEY);
}

function managedCurrentDir(): string {
  return join(managedInstallDir(), 'current');
}

function managedExecutablePath(executableSubpath: string): string {
  return join(managedCurrentDir(), executableSubpath);
}

export async function resolveInstalledChromiumForTestingExecutable(params: Readonly<{
  platform?: NodeJS.Platform | string;
  arch?: string;
  executableSubpath?: string;
}> = {}): Promise<string | null> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const platformKey = resolveChromiumForTestingPlatform(platform, arch);
  if (!platformKey) return null;

  const subpath = params.executableSubpath
    ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platformKey]?.executableSubpath;
  if (!subpath) return null;

  const candidate = managedExecutablePath(subpath);
  const accessMode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

export async function installChromiumForTesting(params: Readonly<{
  platform?: NodeJS.Platform | string;
  arch?: string;
  asset?: ChromiumForTestingPlatformAsset;
  pinnedVersion?: string;
}> = {}): Promise<InstallChromiumForTestingResult> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const platformKey = resolveChromiumForTestingPlatform(platform, arch);
  if (!platformKey) {
    return { ok: false, errorMessage: `Chrome-for-Testing is not supported on ${platform}/${arch}` };
  }

  const asset = params.asset ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platformKey];
  const pinnedVersion = params.pinnedVersion ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.pinnedVersion;
  if (!asset) {
    return { ok: false, errorMessage: `No pinned Chrome-for-Testing asset for ${platformKey}` };
  }

  // External-artifact remainder: without a real, locally-verifiable digest we never download or
  // promote. This is the fail-closed boundary the product gate depends on.
  if (!asset.integrityDigest) {
    return {
      ok: false,
      errorMessage: `Chrome-for-Testing ${pinnedVersion} (${platformKey}) has no pinned integrity digest; source stays fail-closed.`,
    };
  }

  const installRoot = managedInstallDir();
  const scratchDir = await createManagedToolScratchDir({
    installDir: installRoot,
    prefix: MANAGED_KEY,
  });
  try {
    const archiveName = basename(new URL(asset.archiveUrl).pathname) || 'chrome.zip';
    const archivePath = join(scratchDir, archiveName);
    const extractDir = join(scratchDir, 'extract');
    const candidateDir = join(scratchDir, 'candidate');

    // Digest verification happens INSIDE the download helper, before any promotion.
    await downloadGitHubReleaseAsset({
      url: asset.archiveUrl,
      destinationPath: archivePath,
      digest: asset.integrityDigest,
      userAgent: 'happier-cli',
    });

    const payloadRoot = await extractReleasePayloadRootFromArchive({
      archivePath,
      archiveName,
      extractDir,
    });

    // Keep each staged candidate isolated until the shared promotion owner acquires its commit lock.
    await rename(payloadRoot, candidateDir);

    const candidateExecutablePath = join(candidateDir, asset.executableSubpath);
    try {
      await access(candidateExecutablePath, fsConstants.F_OK);
    } catch {
      await rm(candidateDir, { recursive: true, force: true });
      return { ok: false, errorMessage: `Chrome-for-Testing executable missing at ${asset.executableSubpath}` };
    }
    if (platform !== 'win32') {
      await chmod(candidateExecutablePath, 0o755);
    }

    await promoteManagedCurrentInstall({
      installRoot,
      candidatePath: candidateDir,
      currentPath: managedCurrentDir(),
    });

    return {
      ok: true,
      executablePath: managedExecutablePath(asset.executableSubpath),
      pinnedVersion,
      integrityDigest: asset.integrityDigest,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Chrome-for-Testing install failed';
    return { ok: false, errorMessage };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
