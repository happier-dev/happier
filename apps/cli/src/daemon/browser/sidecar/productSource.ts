import { join } from 'node:path';

import type {
    BrowserProfileV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
    resolveSidecarBrowserBinary,
    type SidecarBrowserBinaryCandidate,
    type SidecarBrowserBinaryResolution,
} from './binary';
import type {
    BrowserSidecarControlAdapterFactory,
    BrowserSidecarControlAdapterFactoryResult,
} from './controlAdapter';
import {
    createBrowserSidecarLaunchOwnerControlAdapterFactory,
    type BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
} from './launchOwner';
import { resolveManagedBrowserSidecarCandidate } from './source';
import {
    getBrowserChromiumArchiveDownloadInstallableAdapter,
    type ArchiveDownloadInstallResult,
} from '@/packagedRuntime/installables/sourceAdapters/browserChromium';

const PRODUCT_SOURCE_MISSING_REASON = 'No source-backed managed or packaged Browser sidecar executable is registered.';

// Product whitelist is narrowed to managed-only (FP-BRW-SOURCE-1 step 10a). System/PATH Chrome,
// floating Chrome-for-Testing, Playwright caches, and Electron Chromium must NEVER count as a
// product source — they stay fail-closed forever (TRACKING §10 Category 2). The launch owner and
// `binary.ts` enforce the same invariant defensively.
const PRODUCT_BROWSER_SIDECAR_SOURCES = new Set<SidecarBrowserBinaryCandidate['source']>([
    'managedBrowserPackage',
]);

const PRODUCT_BROWSER_SIDECAR_DISCOVERY_KINDS = new Set<SidecarBrowserBinaryCandidate['discoveryKind']>([
    'managedRuntime',
    'packagedApp',
]);

type CreateLaunchOwnerFactory = (
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
) => BrowserSidecarControlAdapterFactory;

/**
 * Lazy-install trigger seam (MCH-2). The managed browser-chromium source is a per-platform archive
 * fetched on first demand. When `resolveManagedBrowserSidecarCandidate` reports a supported,
 * digest-pinned platform whose artifact is not yet on disk (`available:false`), we run the
 * archive-download adapter once, then let the caller re-resolve. Injectable so the gate stays
 * unit-testable without touching the network.
 */
export type InstallManagedBrowserChromiumFn = (params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
}>) => Promise<ArchiveDownloadInstallResult>;

function defaultInstallManagedBrowserChromium(): InstallManagedBrowserChromiumFn {
    const adapter = getBrowserChromiumArchiveDownloadInstallableAdapter();
    return (params) => adapter.installOrUpgrade(params);
}

function unavailable(
    errorCode: BrowserSidecarErrorCodeV1,
    disabledReason: string,
): Extract<BrowserSidecarControlAdapterFactoryResult, { ok: false }> {
    return {
        ok: false,
        errorCode,
        disabledReason,
    };
}

function isProductCandidate(candidate: SidecarBrowserBinaryCandidate): boolean {
    return PRODUCT_BROWSER_SIDECAR_SOURCES.has(candidate.source)
        && PRODUCT_BROWSER_SIDECAR_DISCOVERY_KINDS.has(candidate.discoveryKind);
}

function missingProductSourceResolution(): SidecarBrowserBinaryResolution {
    return {
        ok: false,
        source: 'managedBrowserPackage',
        errorCode: 'managed_package_missing',
        disabledReason: PRODUCT_SOURCE_MISSING_REASON,
        diagnostics: [],
    };
}

export function resolveProductBrowserSidecarBinary(params: Readonly<{
    platform?: NodeJS.Platform | string;
    candidates?: readonly SidecarBrowserBinaryCandidate[];
}> = {}): SidecarBrowserBinaryResolution {
    const productCandidates = (params.candidates ?? []).filter(isProductCandidate);
    if (productCandidates.length === 0) {
        return missingProductSourceResolution();
    }

    return resolveSidecarBrowserBinary({
        platform: params.platform ?? process.platform,
        sourcePreference: 'managed-first',
        candidates: productCandidates,
    });
}

function defaultEphemeralProfile(machineId: string): BrowserProfileV1 {
    return {
        profileId: `browser_product_${machineId}`,
        storageMode: 'ephemeral',
        owner: { kind: 'session', id: `browser_product_${machineId}` },
        cleanupOnSessionClose: true,
    };
}

function defaultProfileDirectory(machineId: string): string {
    return join(configuration.happyHomeDir, 'tools', 'browser-chromium', 'profiles', `product_${machineId}`);
}

/**
 * The product browser-source gate (BRW-7 / FP-BRW-SOURCE-1). It flips OPEN only for a managed,
 * provenance-verified Chrome-for-Testing candidate resolved by `source.ts`, then delegates to the
 * real launch-owner chain. It stays fail-closed for every other case: no managed artifact
 * installed, missing provenance, or any non-managed/PATH source. There is no `feature_disabled`
 * backstop anymore — a resolved managed source yields a real launch-owner adapter.
 */
export function createProductBrowserSidecarControlAdapterFactory(params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
    // The resolved `browser.sidecar` server feature decision, threaded from the daemon startup
    // gate. Passed to the launch owner so the launch plan's existing `featureEnabled: false`
    // rejection (sidecar/runtime.ts) is the single fail-close point — never a hard-coded `true`.
    featureEnabled: boolean;
    // Product browser-use policy decision. Kept separate from `featureEnabled` because the launch
    // owner has a distinct browser-use denial branch; product callers must derive and thread it
    // instead of letting this source silently force it open.
    browserUseAllowed: boolean;
    resolveManagedCandidate?: typeof resolveManagedBrowserSidecarCandidate;
    createLaunchOwnerFactory?: CreateLaunchOwnerFactory;
    // Lazy-install trigger (MCH-2). When `false`, a missing artifact stays fail-closed instead of
    // fetching on demand (used to preserve the existing strict-resolution behavior in tests/QA).
    autoInstallWhenMissing?: boolean;
    installManagedBrowserChromium?: InstallManagedBrowserChromiumFn;
}>): BrowserSidecarControlAdapterFactory {
    const resolveCandidate = params.resolveManagedCandidate ?? resolveManagedBrowserSidecarCandidate;
    const createLaunchOwner = params.createLaunchOwnerFactory
        ?? createBrowserSidecarLaunchOwnerControlAdapterFactory;
    const autoInstallWhenMissing = params.autoInstallWhenMissing ?? true;
    const installManagedBrowserChromium = params.installManagedBrowserChromium
        ?? defaultInstallManagedBrowserChromium();
    const platform = params.platform ?? process.platform;
    const arch = params.arch ?? process.arch;

    return async (factoryInput) => {
        if (!params.browserUseAllowed) {
            return unavailable('browser_policy_denied', 'browser use denied by policy');
        }

        let candidate = await resolveCandidate({ platform, arch });

        // Lazy-install seam: a supported, digest-pinned platform whose artifact is not yet installed
        // surfaces as `available:false` (NOT null). Trigger the archive-download adapter once, then
        // re-resolve so the freshly-installed binary can promote to a real candidate.
        if (autoInstallWhenMissing && candidate && candidate.available === false) {
            const installResult = await installManagedBrowserChromium({ platform, arch });
            if (installResult.ok) {
                candidate = await resolveCandidate({ platform, arch });
            }
        }

        if (!candidate) {
            return unavailable('managed_package_missing', PRODUCT_SOURCE_MISSING_REASON);
        }

        const binaryResolution = resolveProductBrowserSidecarBinary({
            platform,
            candidates: [candidate],
        });
        if (!binaryResolution.ok) {
            return unavailable(binaryResolution.errorCode, binaryResolution.disabledReason);
        }

        // Provenance is mandatory: a managed candidate without a locally-verified pinned digest
        // must never reach the launch owner. This is the BRW-7 acceptance invariant.
        if (binaryResolution.provenance?.origin !== 'managed_package') {
            return unavailable(
                'binary_resolution_failed',
                'Managed Browser sidecar source resolved without verified provenance.',
            );
        }

        const machineId = factoryInput.machineId;
        const launchOwnerFactory = createLaunchOwner({
            browserSessionId: `browser_product_${machineId}`,
            sidecarId: `sidecar_product_${machineId}`,
            featureEnabled: params.featureEnabled,
            browserUseAllowed: params.browserUseAllowed,
            allowPersistentProfiles: false,
            profile: defaultEphemeralProfile(machineId),
            profileDirectory: defaultProfileDirectory(machineId),
            binaryResolution,
        });

        return launchOwnerFactory(factoryInput);
    };
}
