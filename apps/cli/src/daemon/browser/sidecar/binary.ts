import type {
    BrowserSidecarBinaryProvenanceV1,
    BrowserSidecarBinarySourceV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

export type SidecarBrowserBinaryDiscoveryKind =
    | 'managedRuntime'
    | 'explicitUserConfig'
    | 'systemRegistry'
    | 'packagedApp'
    | 'pathProbe';

export type SidecarBrowserBinaryCandidate = Readonly<{
    source: BrowserSidecarBinarySourceV1;
    executablePath?: string;
    discoveryKind: SidecarBrowserBinaryDiscoveryKind;
    available: boolean;
    disabledReason?: string;
    /**
     * Locally-derived provenance for a managed candidate (pinned version/channel + verified
     * sha256 digest + license). Present only for product-eligible managed sources. The resolver
     * threads it into the successful resolution; product binary resolution requires it
     * before any launch consumer. A candidate without provenance can never become a
     * product source.
     */
    provenance?: BrowserSidecarBinaryProvenanceV1;
}>;

export type SidecarBrowserBinaryDiagnostic = Readonly<{
    source: BrowserSidecarBinarySourceV1;
    discoveryKind: SidecarBrowserBinaryDiscoveryKind;
    available: boolean;
    errorCode?: BrowserSidecarErrorCodeV1;
    disabledReason?: string;
}>;

export type SidecarBrowserBinaryResolution =
    | Readonly<{
        ok: true;
        source: BrowserSidecarBinarySourceV1;
        executablePath: string;
        discoveryKind: SidecarBrowserBinaryDiscoveryKind;
        provenance?: BrowserSidecarBinaryProvenanceV1;
        diagnostics: readonly SidecarBrowserBinaryDiagnostic[];
    }>
    | Readonly<{
        ok: false;
        source: BrowserSidecarBinarySourceV1;
        errorCode: BrowserSidecarErrorCodeV1;
        disabledReason: string;
        diagnostics: readonly SidecarBrowserBinaryDiagnostic[];
    }>;

const SUPPORTED_PLATFORMS = new Set<string>(['darwin', 'linux', 'win32']);

export type ProductBrowserSidecarBinaryResolution =
    | Extract<SidecarBrowserBinaryResolution, { ok: false }>
    | Readonly<Omit<Extract<SidecarBrowserBinaryResolution, { ok: true }>, 'source' | 'provenance'> & {
        source: 'managedBrowserPackage';
        provenance: BrowserSidecarBinaryProvenanceV1;
    }>;

/** Resolve the managed product source with provenance supplied by the installed-artifact owner. */
export function resolveProductBrowserSidecarBinary(params: Readonly<{
    platform?: NodeJS.Platform | string;
    candidates?: readonly SidecarBrowserBinaryCandidate[];
}> = {}): ProductBrowserSidecarBinaryResolution {
    const productCandidates = (params.candidates ?? []).filter(candidate => (
        candidate.source === 'managedBrowserPackage'
        && (candidate.discoveryKind === 'managedRuntime' || candidate.discoveryKind === 'packagedApp')
    ));
    if (productCandidates.length === 0) {
        return {
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
            disabledReason: 'No source-backed managed or packaged Browser sidecar executable is registered.',
            diagnostics: [],
        };
    }
    const diagnostics: SidecarBrowserBinaryDiagnostic[] = productCandidates.map(candidate => {
        const available = candidate.available && Boolean(candidate.executablePath?.trim());
        return {
            source: candidate.source,
            discoveryKind: candidate.discoveryKind,
            available,
            ...(available ? {} : {
                errorCode: 'binary_resolution_failed' as const,
                disabledReason: candidate.disabledReason ?? 'Browser sidecar binary candidate is unavailable.',
            }),
        };
    });
    const platform = params.platform ?? process.platform;
    if (!SUPPORTED_PLATFORMS.has(platform)) {
        return {
            ok: false,
            source: 'unsupported',
            errorCode: 'unsupported_platform',
            disabledReason: `Browser sidecar runtime is not supported on ${platform}.`,
            diagnostics,
        };
    }
    const candidate = productCandidates.find(candidate => candidate.available && candidate.executablePath?.trim());
    const executablePath = candidate?.executablePath?.trim();
    if (!candidate || !executablePath) {
        return {
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
            disabledReason: 'Managed browser package is not installed or not launchable.',
            diagnostics,
        };
    }
    const provenance = candidate.provenance;
    if (provenance?.origin !== 'managed_package') {
        return {
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'binary_resolution_failed',
            disabledReason: 'Managed Browser sidecar source resolved without verified provenance.',
            diagnostics,
        };
    }
    return {
        ok: true,
        source: 'managedBrowserPackage',
        executablePath,
        discoveryKind: candidate.discoveryKind,
        provenance,
        diagnostics,
    };
}
