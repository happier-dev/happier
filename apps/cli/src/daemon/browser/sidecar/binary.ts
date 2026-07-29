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
     * threads it into the successful resolution; the product gate (`productSource.ts`) requires it
     * before delegating to the launch owner. A candidate without provenance can never become a
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

type SidecarBrowserBinarySourcePreference = 'managed-first' | 'system-first';

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux', 'win32']);

const MANAGED_FIRST_PRIORITY: readonly BrowserSidecarBinarySourceV1[] = [
    'managedBrowserPackage',
    'chromeForTesting',
    'playwrightChromium',
    'electronChromium',
    'systemChrome',
];

const SYSTEM_FIRST_PRIORITY: readonly BrowserSidecarBinarySourceV1[] = [
    'systemChrome',
    'managedBrowserPackage',
    'chromeForTesting',
    'playwrightChromium',
    'electronChromium',
];

function sourcePriority(
    source: BrowserSidecarBinarySourceV1,
    preference: SidecarBrowserBinarySourcePreference,
): number {
    const priority = preference === 'system-first' ? SYSTEM_FIRST_PRIORITY : MANAGED_FIRST_PRIORITY;
    const index = priority.indexOf(source);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function nonEmptyExecutablePath(candidate: SidecarBrowserBinaryCandidate): string | null {
    const value = candidate.executablePath?.trim();
    return value ? value : null;
}

function isBinarySafeSystemCandidate(candidate: SidecarBrowserBinaryCandidate): boolean {
    return candidate.source !== 'systemChrome' || candidate.discoveryKind !== 'pathProbe';
}

function diagnosticFor(candidate: SidecarBrowserBinaryCandidate): SidecarBrowserBinaryDiagnostic {
    const hasExecutablePath = nonEmptyExecutablePath(candidate) !== null;
    const pathOnlySystemCandidate = candidate.source === 'systemChrome' && candidate.discoveryKind === 'pathProbe';
    const available = candidate.available && hasExecutablePath && !pathOnlySystemCandidate;

    return {
        source: candidate.source,
        discoveryKind: candidate.discoveryKind,
        available,
        ...(available ? {} : {
            errorCode: pathOnlySystemCandidate ? 'system_browser_unavailable' : 'binary_resolution_failed',
            disabledReason: candidate.disabledReason
                ?? (pathOnlySystemCandidate
                    ? 'PATH-only browser discovery is not binary-safe for sidecar runtime launch.'
                    : 'Browser sidecar binary candidate is unavailable.'),
        }),
    };
}

function resolveFailure(input: Readonly<{
    candidates: readonly SidecarBrowserBinaryCandidate[];
    diagnostics: readonly SidecarBrowserBinaryDiagnostic[];
}>): SidecarBrowserBinaryResolution {
    const systemDiagnostic = input.diagnostics.find((diagnostic) => diagnostic.source === 'systemChrome');
    if (systemDiagnostic?.errorCode === 'system_browser_unavailable') {
        return {
            ok: false,
            source: 'systemChrome',
            errorCode: 'system_browser_unavailable',
            disabledReason: systemDiagnostic.disabledReason ?? 'No binary-safe system browser candidate is available.',
            diagnostics: input.diagnostics,
        };
    }

    const managedCandidateExists = input.candidates.some((candidate) => candidate.source === 'managedBrowserPackage');
    if (managedCandidateExists || input.candidates.length === 0) {
        return {
            ok: false,
            source: 'managedBrowserPackage',
            errorCode: 'managed_package_missing',
            disabledReason: 'Managed browser package is not installed or not launchable.',
            diagnostics: input.diagnostics,
        };
    }

    return {
        ok: false,
        source: input.candidates[0]?.source ?? 'managedBrowserPackage',
        errorCode: 'binary_resolution_failed',
        disabledReason: 'No eligible browser sidecar binary candidate is available.',
        diagnostics: input.diagnostics,
    };
}

export function resolveSidecarBrowserBinary(params: Readonly<{
    platform: NodeJS.Platform | string;
    sourcePreference?: SidecarBrowserBinarySourcePreference;
    candidates: readonly SidecarBrowserBinaryCandidate[];
}>): SidecarBrowserBinaryResolution {
    const diagnostics = params.candidates.map(diagnosticFor);
    if (!SUPPORTED_PLATFORMS.has(params.platform as NodeJS.Platform)) {
        return {
            ok: false,
            source: 'unsupported',
            errorCode: 'unsupported_platform',
            disabledReason: `Browser sidecar runtime is not supported on ${params.platform}.`,
            diagnostics,
        };
    }

    const preference = params.sourcePreference ?? 'managed-first';
    const sortedCandidates = [...params.candidates].sort((left, right) => (
        sourcePriority(left.source, preference) - sourcePriority(right.source, preference)
    ));

    for (const candidate of sortedCandidates) {
        const executablePath = nonEmptyExecutablePath(candidate);
        if (!candidate.available || !executablePath || !isBinarySafeSystemCandidate(candidate)) {
            continue;
        }

        return {
            ok: true,
            source: candidate.source,
            executablePath,
            discoveryKind: candidate.discoveryKind,
            ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
            diagnostics,
        };
    }

    return resolveFailure({ candidates: params.candidates, diagnostics });
}
