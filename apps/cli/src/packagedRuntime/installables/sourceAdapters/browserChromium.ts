import { CHROMIUM_FOR_TESTING_PRODUCT_SOURCE } from '@happier-dev/protocol';

import {
  installChromiumForTesting,
  resolveInstalledChromiumForTestingExecutable,
} from './chromiumForTesting';

/**
 * Archive-download installable adapter for the managed Chrome-for-Testing browser source (MCH-2).
 *
 * Chrome-for-Testing is a per-platform archive (a `chrome-{platform}.zip`), NOT an npm-shaped
 * `managed_package` nor a `dep.*` system CLI. It therefore gets its OWN archive-download
 * source-kind + adapter rather than being forced through the `managed_package`/`managed_js_runtime`
 * branch. The adapter is binary-runtime compliant: it reuses `downloadGitHubReleaseAsset`
 * (digest-verified download) + `extractReleasePayloadRootFromArchive` (atomic promotion) via
 * `installChromiumForTesting`, and never spawns a package manager.
 *
 * It is keyed by the protocol product-source `key` (`'browser-chromium'`) so the registry can route
 * the launch-miss lazy-install trigger to exactly this adapter.
 */
export const ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND = 'archive_download' as const;
export type ArchiveDownloadInstallableSourceKind = typeof ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND;

export const BROWSER_CHROMIUM_INSTALLABLE_KEY = CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.key;
export type BrowserChromiumInstallableKey = typeof BROWSER_CHROMIUM_INSTALLABLE_KEY;

export type ArchiveDownloadInstallResult =
  | Readonly<{ ok: true; executablePath: string; pinnedVersion: string; integrityDigest: string }>
  | Readonly<{ ok: false; errorMessage: string }>;

export type ArchiveDownloadInstallableAdapter = Readonly<{
  key: BrowserChromiumInstallableKey;
  sourceKind: ArchiveDownloadInstallableSourceKind;
  /** Resolve the already-installed managed executable path, or `null` when not yet installed. */
  resolveInstalledExecutable: (params?: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
  }>) => Promise<string | null>;
  /** Digest-verified download + atomic promotion of the pinned per-platform archive. */
  installOrUpgrade: (params?: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
  }>) => Promise<ArchiveDownloadInstallResult>;
}>;

/**
 * The single archive-download adapter for the managed browser-chromium source. There is exactly one
 * archive-download installable today (Chrome-for-Testing); the registry routes by `key`.
 */
export function getBrowserChromiumArchiveDownloadInstallableAdapter(): ArchiveDownloadInstallableAdapter {
  return {
    key: BROWSER_CHROMIUM_INSTALLABLE_KEY,
    sourceKind: ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
    resolveInstalledExecutable: (params = {}) =>
      resolveInstalledChromiumForTestingExecutable({
        platform: params.platform,
        arch: params.arch,
      }),
    installOrUpgrade: (params = {}) =>
      installChromiumForTesting({
        platform: params.platform,
        arch: params.arch,
      }),
  };
}
