import type { ScmHostingProviderContribution } from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeAdapter,
    ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk';

export type ScmHostingProviderDescriptor = Readonly<Omit<ScmHostingProviderContribution, 'urlSafety'> & {
    pluginId?: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls: readonly string[];
        allowedOrigins: readonly string[];
    }>;
}>;

export type ScmHostingProviderRuntimeBinding = Readonly<{
    pluginId: string;
    registration: ScmHostingProviderRuntimeRegistration;
}>;

type ScmHostingProviderRegistryDiagnostic = Readonly<{
    code: string;
    message: string;
    pluginId?: string;
    providerId?: string;
}>;

type ResolvedScmHostingProvider = ScmHostingProviderDescriptor & Readonly<{
    runtime?: ScmHostingProviderRuntimeBinding;
}>;

type ScmHostingProviderRemoteDetectionInput = Readonly<{
    remoteName: string | null;
    remoteUrl: string;
}>;

type UnresolvedScmHostingProvider = Readonly<{
    id: 'unknown';
    kind: 'unknown';
    displayName: string;
    remoteName?: string | null;
    unsupportedReason: string;
}>;

type ScmHostingProviderResolvedRemote = Readonly<{
    id: string;
    kind: string;
    displayName: string;
    baseUrl: string;
    repositoryWebUrl?: string;
    nameWithOwner?: string;
    remoteName?: string | null;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls?: readonly string[];
        allowedOrigins?: readonly string[];
    }>;
}>;

type ScmHostingProviderRoutingAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote;
        base: string;
        head: string;
    }>) => string | null;
}>;

type ScmHostingProviderRemoteDetectionResult =
    | Readonly<{
        kind: 'resolved';
        providerId: string;
        provider: ScmHostingProviderResolvedRemote;
    }>
    | Readonly<{
        kind: 'unknown';
        provider: UnresolvedScmHostingProvider;
    }>;

type ScmHostingProviderCompareUrlResult =
    | Readonly<{
        kind: 'resolved';
        url: string;
    }>
    | Readonly<{
        kind: 'unsupported';
        reason: 'unknown_provider' | 'adapter_unavailable' | 'unsupported_by_provider';
        provider: ScmHostingProviderResolvedRemote | UnresolvedScmHostingProvider;
    }>;

export type ResolvedScmHostingProviderRegistry = Readonly<{
    providers: readonly ResolvedScmHostingProvider[];
    providersById: ReadonlyMap<string, ResolvedScmHostingProvider>;
    diagnostics: readonly ScmHostingProviderRegistryDiagnostic[];
    getProvider: (id: string) => ResolvedScmHostingProvider | undefined;
    getAdapter: (id: string) => ScmHostingProviderRuntimeAdapter | undefined;
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderRemoteDetectionResult;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote | UnresolvedScmHostingProvider;
        base: string;
        head: string;
    }>) => ScmHostingProviderCompareUrlResult;
}>;

function createMissingScmHostingProviderDescriptorDiagnostic(params: Readonly<{
    pluginId: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    return {
        code: 'scm_hosting_provider_registration_missing_descriptor',
        pluginId: params.pluginId,
        providerId: params.providerId,
        message: `Plugin '${params.pluginId}' registered SCM hosting provider '${params.providerId}' without a matching static descriptor`,
    };
}

function createScmHostingProviderPluginMismatchDiagnostic(params: Readonly<{
    descriptorPluginId: string;
    registrationPluginId: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    return {
        code: 'scm_hosting_provider_registration_plugin_mismatch',
        pluginId: params.registrationPluginId,
        providerId: params.providerId,
        message: `Plugin '${params.registrationPluginId}' registered SCM hosting provider '${params.providerId}' declared by plugin '${params.descriptorPluginId}'`,
    };
}

function createDuplicateScmHostingProviderDiagnostic(params: Readonly<{
    existingPluginId?: string;
    pluginId?: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    const pluginId = params.pluginId?.trim() || 'unknown';
    const existingPluginId = params.existingPluginId?.trim() || 'unknown';
    return {
        code: 'scm_hosting_provider_duplicate',
        pluginId,
        providerId: params.providerId,
        message: `Duplicate SCM hosting provider '${params.providerId}' from plugin '${pluginId}' conflicts with plugin '${existingPluginId}'`,
    };
}

function readScmHostingProviderUrlSafety(
    provider: ScmHostingProviderDescriptor,
): NonNullable<ScmHostingProviderDescriptor['urlSafety']> {
    return Object.freeze({
        allowedSchemes: provider.urlSafety?.allowedSchemes?.length
            ? Object.freeze([...provider.urlSafety.allowedSchemes])
            : Object.freeze(['https:']),
        allowedBaseUrls: Object.freeze([...(provider.urlSafety?.allowedBaseUrls ?? [])]),
        allowedOrigins: Object.freeze([...(provider.urlSafety?.allowedOrigins ?? [])]),
    });
}

function isScmHostingProviderRoutingAdapter(
    adapter: unknown,
): adapter is ScmHostingProviderRoutingAdapter {
    const candidate = adapter as Partial<Record<'detectRemote' | 'buildCompareUrl', unknown>>;
    return Boolean(adapter)
        && typeof candidate.detectRemote === 'function'
        && typeof candidate.buildCompareUrl === 'function';
}

function createUnknownProvider(remoteName: string | null): UnresolvedScmHostingProvider {
    return Object.freeze({
        id: 'unknown',
        kind: 'unknown',
        displayName: 'Unknown SCM hosting provider',
        ...(remoteName ? { remoteName } : {}),
        unsupportedReason: 'no_registered_provider_detected',
    });
}

function isUnresolvedScmHostingProvider(
    provider: Readonly<{ id: string; kind: string }>,
): provider is UnresolvedScmHostingProvider {
    return provider.id === 'unknown' && provider.kind === 'unknown';
}

function normalizeUrlPath(pathname: string): string {
    const trimmed = pathname.replace(/\/+$/, '');
    return trimmed || '/';
}

function isUrlWithinBaseUrl(url: URL, baseUrl: URL): boolean {
    if (url.origin !== baseUrl.origin) {
        return false;
    }

    const basePath = normalizeUrlPath(baseUrl.pathname);
    if (basePath === '/') {
        return true;
    }

    const targetPath = normalizeUrlPath(url.pathname);
    return targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

function readDetectedProviderAllowedSchemes(descriptor: ResolvedScmHostingProvider): readonly string[] {
    if (descriptor.urlSafety?.allowedSchemes?.length) {
        return descriptor.urlSafety.allowedSchemes;
    }
    return ['https:'];
}

function parseUrlWithAllowedScheme(value: string, allowedSchemes: readonly string[]): URL | null {
    try {
        const url = new URL(value);
        return allowedSchemes.includes(url.protocol) ? url : null;
    } catch {
        return null;
    }
}

function resolveDetectedRepositoryWebUrl(
    detectedProvider: ScmHostingProviderResolvedRemote,
    descriptor: ResolvedScmHostingProvider,
): string | undefined {
    if (!detectedProvider.repositoryWebUrl) {
        return undefined;
    }

    const allowedSchemes = readDetectedProviderAllowedSchemes(descriptor);
    const repositoryWebUrl = parseUrlWithAllowedScheme(detectedProvider.repositoryWebUrl, allowedSchemes);
    const providerBaseUrl = parseUrlWithAllowedScheme(detectedProvider.baseUrl, allowedSchemes);
    if (!repositoryWebUrl || !providerBaseUrl) {
        return undefined;
    }
    if (
        repositoryWebUrl.username
        || repositoryWebUrl.password
        || repositoryWebUrl.search
        || repositoryWebUrl.hash
    ) {
        return undefined;
    }
    if (!isUrlWithinBaseUrl(repositoryWebUrl, providerBaseUrl)) {
        return undefined;
    }

    return repositoryWebUrl.toString().replace(/\/+$/, '');
}

function normalizeDetectedProvider(
    provider: ScmHostingProviderResolvedRemote,
    descriptor: ResolvedScmHostingProvider,
): ScmHostingProviderResolvedRemote {
    const repositoryWebUrl = resolveDetectedRepositoryWebUrl(provider, descriptor);
    return Object.freeze({
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        ...(repositoryWebUrl ? { repositoryWebUrl } : {}),
        ...(provider.nameWithOwner ? { nameWithOwner: provider.nameWithOwner } : {}),
        ...(provider.remoteName !== undefined ? { remoteName: provider.remoteName } : {}),
        ...(provider.urlSafety ? { urlSafety: provider.urlSafety } : {}),
    });
}

export function createScmHostingProviderRegistry(params: Readonly<{
    providers: readonly ScmHostingProviderDescriptor[];
    runtimeRegistrations?: readonly ScmHostingProviderRuntimeBinding[];
}>): ResolvedScmHostingProviderRegistry {
    const diagnostics: ScmHostingProviderRegistryDiagnostic[] = [];
    const providersById = new Map<string, ResolvedScmHostingProvider>();
    const runtimeByProviderId = new Map<string, ScmHostingProviderRuntimeBinding>();

    for (const binding of params.runtimeRegistrations ?? []) {
        const existing = runtimeByProviderId.get(binding.registration.id);
        if (existing) {
            diagnostics.push(createDuplicateScmHostingProviderDiagnostic({
                existingPluginId: existing.pluginId,
                pluginId: binding.pluginId,
                providerId: binding.registration.id,
            }));
            continue;
        }
        runtimeByProviderId.set(binding.registration.id, binding);
    }

    for (const provider of params.providers) {
        const existing = providersById.get(provider.id);
        if (existing) {
            diagnostics.push(createDuplicateScmHostingProviderDiagnostic({
                existingPluginId: existing.pluginId,
                pluginId: provider.pluginId,
                providerId: provider.id,
            }));
            continue;
        }
        const runtime = runtimeByProviderId.get(provider.id);
        if (runtime && provider.pluginId && provider.pluginId !== runtime.pluginId) {
            diagnostics.push(createScmHostingProviderPluginMismatchDiagnostic({
                descriptorPluginId: provider.pluginId,
                registrationPluginId: runtime.pluginId,
                providerId: provider.id,
            }));
            providersById.set(provider.id, Object.freeze({
                ...provider,
                urlSafety: readScmHostingProviderUrlSafety(provider),
            }));
            continue;
        }

        providersById.set(provider.id, Object.freeze({
            ...provider,
            urlSafety: readScmHostingProviderUrlSafety(provider),
            ...(runtime ? { runtime } : {}),
        }));
    }

    for (const binding of params.runtimeRegistrations ?? []) {
        if (!providersById.has(binding.registration.id)) {
            diagnostics.push(createMissingScmHostingProviderDescriptorDiagnostic({
                pluginId: binding.pluginId,
                providerId: binding.registration.id,
            }));
        }
    }

    const providers = Object.freeze([...providersById.values()].sort((left, right) => left.id.localeCompare(right.id)));

    return Object.freeze({
        providers,
        providersById: Object.freeze(providersById),
        diagnostics: Object.freeze(diagnostics),
        getProvider(id) {
            return providersById.get(id);
        },
        getAdapter(id) {
            return providersById.get(id)?.runtime?.registration.adapter;
        },
        detectRemote(input) {
            for (const provider of providers) {
                const adapter = provider.runtime?.registration.adapter;
                if (!isScmHostingProviderRoutingAdapter(adapter)) {
                    continue;
                }
                const detected = adapter.detectRemote(input);
                if (!detected) {
                    continue;
                }
                return Object.freeze({
                    kind: 'resolved' as const,
                    providerId: provider.id,
                    provider: normalizeDetectedProvider(detected, provider),
                });
            }
            return Object.freeze({
                kind: 'unknown' as const,
                provider: createUnknownProvider(input.remoteName),
            });
        },
        buildCompareUrl(input) {
            const provider = input.provider;
            if (isUnresolvedScmHostingProvider(provider)) {
                return Object.freeze({
                    kind: 'unsupported' as const,
                    reason: 'unknown_provider' as const,
                    provider,
                });
            }
            const adapter = providersById.get(provider.id)?.runtime?.registration.adapter;
            if (!isScmHostingProviderRoutingAdapter(adapter)) {
                return Object.freeze({
                    kind: 'unsupported' as const,
                    reason: 'adapter_unavailable' as const,
                    provider,
                });
            }
            const url = adapter.buildCompareUrl({
                provider,
                base: input.base,
                head: input.head,
            });
            if (!url) {
                return Object.freeze({
                    kind: 'unsupported' as const,
                    reason: 'unsupported_by_provider' as const,
                    provider,
                });
            }
            return Object.freeze({
                kind: 'resolved' as const,
                url,
            });
        },
    });
}
