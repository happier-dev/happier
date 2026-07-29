import {
    CHROMIUM_FOR_TESTING_PRODUCT_SOURCE,
    resolveChromiumForTestingPlatform,
    type BrowserSidecarBinaryProvenanceV1,
    type ChromiumForTestingPlatformAsset,
} from '@happier-dev/protocol';

import { resolveInstalledChromiumForTestingExecutable } from '@/packagedRuntime/installables/sourceAdapters/chromiumForTesting';
import type { SidecarBrowserBinaryCandidate } from './binary';

/**
 * Maps the installed managed Chrome-for-Testing artifact into a provenance-bearing sidecar binary
 * candidate (FP-BRW-SOURCE-1). This is the ONLY production path that produces a
 * `source: 'managedBrowserPackage'` candidate with populated provenance — the product gate
 * (`productSource.ts`) consumes it.
 *
 * FAIL-CLOSED: returns `null` (no candidate at all) on unsupported platform OR when the pinned
 * asset lacks a verified digest (external-artifact remainder). When the platform is supported and
 * the asset is digest-pinned but the artifact is not yet installed on disk, it returns an
 * `available: false` candidate (no provenance) so the resolver reports `managed_package_missing`
 * rather than silently succeeding.
 */
export async function resolveManagedBrowserSidecarCandidate(params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
    /** Test/QA seam to inject a digest-pinned asset; production uses the protocol descriptor. */
    assetOverride?: ChromiumForTestingPlatformAsset;
}> = {}): Promise<SidecarBrowserBinaryCandidate | null> {
    const platform = params.platform ?? process.platform;
    const arch = params.arch ?? process.arch;
    const platformKey = resolveChromiumForTestingPlatform(platform, arch);
    if (!platformKey) {
        return null;
    }

    const asset = params.assetOverride ?? CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platformKey];
    if (!asset) {
        return null;
    }

    // External-artifact remainder: an asset without a locally-verifiable digest can never become a
    // product source. Return no candidate so the gate stays closed.
    if (!asset.integrityDigest) {
        return null;
    }

    const executablePath = await resolveInstalledChromiumForTestingExecutable({
        platform,
        arch,
        executableSubpath: asset.executableSubpath,
    });

    if (!executablePath) {
        return {
            source: 'managedBrowserPackage',
            discoveryKind: 'managedRuntime',
            available: false,
            disabledReason: `Managed Chrome-for-Testing ${CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.pinnedVersion} is not installed.`,
        };
    }

    const provenance: BrowserSidecarBinaryProvenanceV1 = {
        origin: 'managed_package',
        pinnedVersion: CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.pinnedVersion,
        channel: CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.channel,
        integrityDigest: asset.integrityDigest,
        license: CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.license,
    };

    return {
        source: 'managedBrowserPackage',
        discoveryKind: 'managedRuntime',
        available: true,
        executablePath,
        provenance,
    };
}
