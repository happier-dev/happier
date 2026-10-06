import { CHROMIUM_FOR_TESTING_PRODUCT_SOURCE, resolveChromiumForTestingPlatform, resolveChromiumForTestingAssetVersion } from '@happier-dev/protocol/browser/sidecar/chromiumForTesting';
import type { ChromiumForTestingPlatformAsset } from '@happier-dev/protocol';
import { DEFAULT_ARCHIVE_EXTRACTION_LIMITS } from '@happier-dev/release-runtime/archiveExtraction';
import { installPinnedArchive, resolveInstalledPinnedArchiveExecutable } from './pinnedArchive';

/**
 * Chrome-for-Testing projection over the reusable pinned-archive installer.
 */

const MANAGED_KEY = CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.key;

export type InstallChromiumForTestingResult =
  | Readonly<{ ok: true; executablePath: string; pinnedVersion: string; integrityDigest: string }>
  | Readonly<{ ok: false; errorMessage: string }>;

export async function resolveInstalledChromiumForTestingExecutable(params: Readonly<{
  platform?: NodeJS.Platform | string;
  arch?: string;
  executableSubpath?: string;
  asset?: ChromiumForTestingPlatformAsset;
}> = {}): Promise<string | null> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const platformKey = resolveChromiumForTestingPlatform(platform, arch);
  if (!platformKey) return null;

  const asset = params.asset ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platformKey];
  if (!asset) return null;
  const subpath = params.executableSubpath ?? asset.executableSubpath;
  if (!subpath) return null;

  return await resolveInstalledPinnedArchiveExecutable({
    installId: MANAGED_KEY,
    executableSubpath: subpath,
    version: resolveChromiumForTestingAssetVersion(asset),
    platform,
  });
}

export async function installChromiumForTesting(params: Readonly<{
  platform?: NodeJS.Platform | string;
  arch?: string;
  asset?: ChromiumForTestingPlatformAsset;
  pinnedVersion?: string;
  signal?: AbortSignal;
}> = {}): Promise<InstallChromiumForTestingResult> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const platformKey = resolveChromiumForTestingPlatform(platform, arch);
  if (!platformKey) {
    return { ok: false, errorMessage: `Chrome-for-Testing is not supported on ${platform}/${arch}` };
  }

  const asset = params.asset ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platformKey];
  if (!asset) {
    return { ok: false, errorMessage: `No pinned Chrome-for-Testing asset for ${platformKey}` };
  }
  const pinnedVersion = params.pinnedVersion ?? resolveChromiumForTestingAssetVersion(asset);

  // External-artifact remainder: without a real, locally-verifiable digest we never download or
  // promote. This is the fail-closed boundary the product gate depends on.
  if (!asset.integrityDigest) {
    return {
      ok: false,
      errorMessage: `Chrome-for-Testing ${pinnedVersion} (${platformKey}) has no pinned integrity digest; source stays fail-closed.`,
    };
  }

  const sha256 = asset.integrityDigest.startsWith('sha256:')
    ? asset.integrityDigest.slice('sha256:'.length)
    : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { ok: false, errorMessage: `Chrome-for-Testing ${pinnedVersion} (${platformKey}) has an invalid pinned integrity digest.` };
  }
  const result = await installPinnedArchive({
    signal: params.signal,
    installId: MANAGED_KEY,
    version: pinnedVersion,
    asset: {
      archiveUrl: asset.archiveUrl,
      sha256,
      executableSubpath: asset.executableSubpath,
    },
    platform,
    // Real pinned Chromium executables exceed the generic per-file budget. Extraction
    // is streamed; reuse the existing total expansion budget instead of a shorter cap.
    archiveExtractionLimits: { maxFileBytes: DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxExpandedBytes },
  });
  return result.ok
    ? { ok: true, executablePath: result.executablePath, pinnedVersion, integrityDigest: result.integrityDigest }
    : result;
}
