import {
    ScmHostingProviderKindSchema,
    type ScmHostingProviderContribution,
} from '@happier-dev/protocol';
import type {
    HostingProviderRuntimeAdapter as ScmHostingProviderRuntimeAdapter,
    HostingProviderRuntimeRegistration as ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/scm/hosting';
import { createGuardedRuntimeView } from '@/plugins/runtime/guardedRuntimeView';

import { runWithHostingProviderExecutionAuthority } from './executionAuthority';

export type ScmHostingProviderDescriptor = Readonly<Omit<ScmHostingProviderContribution, 'title'> & {
    pluginId?: string;
    displayName: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls: readonly string[];
        allowedOrigins: readonly string[];
    }>;
}>;

export type ScmHostingProviderRuntimeBinding = Readonly<{
    pluginId: string;
    generation: string;
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

type ScmHostingProviderDetectionAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
}>;

type ScmHostingProviderCompareAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
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

function isScmHostingProviderDetectionAdapter(
    adapter: unknown,
): adapter is ScmHostingProviderDetectionAdapter {
    return Boolean(adapter)
        && typeof (adapter as Readonly<{ detectRemote?: unknown }>).detectRemote === 'function';
}

function isScmHostingProviderCompareAdapter(
    adapter: unknown,
): adapter is ScmHostingProviderCompareAdapter {
    return Boolean(adapter)
        && typeof (adapter as Readonly<{ buildCompareUrl?: unknown }>).buildCompareUrl === 'function';
}

function bindRuntimeAdapter(
    binding: ScmHostingProviderRuntimeBinding,
): ScmHostingProviderRuntimeAdapter {
    const target = binding.registration.adapter;
    const boundMethods = new WeakMap<Function, Function>();

    // Registration already published a frozen, receiver-bound callback map.
    // This consumer adds only its execution-authority context at invocation;
    // rebuilding descriptors here would create a second runtime topology.
    return createGuardedRuntimeView({
        owner: target,
        guard: (value) => {
            if (typeof value !== 'function') return value;
            const method = value as (...args: readonly unknown[]) => unknown;
            const cached = boundMethods.get(method);
            if (cached) return cached;
            const bound = Object.freeze((...args: readonly unknown[]) => runWithHostingProviderExecutionAuthority(
                {
                    pluginId: binding.pluginId,
                    generation: binding.generation,
                    contributionId: binding.registration.id,
                },
                () => Reflect.apply(method, target, args),
            ));
            boundMethods.set(method, bound);
            return bound;
        },
    });
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

function isProviderBaseAllowedByDescriptor(
    providerBaseUrl: URL,
    descriptor: ResolvedScmHostingProvider,
): boolean {
    const allowedSchemes = readDetectedProviderAllowedSchemes(descriptor);
    const allowedBaseUrls = descriptor.urlSafety?.allowedBaseUrls ?? [];
    if (allowedBaseUrls.length > 0 && !allowedBaseUrls.some((value) => {
        const allowedBaseUrl = parseUrlWithAllowedScheme(value, allowedSchemes);
        return Boolean(
            allowedBaseUrl
            && !allowedBaseUrl.username
            && !allowedBaseUrl.password
            && !allowedBaseUrl.search
            && !allowedBaseUrl.hash
            && isUrlWithinBaseUrl(providerBaseUrl, allowedBaseUrl)
        );
    })) {
        return false;
    }

    const allowedOrigins = descriptor.urlSafety?.allowedOrigins ?? [];
    if (allowedOrigins.length > 0 && !allowedOrigins.some((value) => {
        const allowedOrigin = parseUrlWithAllowedScheme(value, allowedSchemes);
        return Boolean(
            allowedOrigin
            && !allowedOrigin.username
            && !allowedOrigin.password
            && !allowedOrigin.search
            && !allowedOrigin.hash
            && allowedOrigin.origin === providerBaseUrl.origin
        );
    })) {
        return false;
    }

    return true;
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
): ScmHostingProviderResolvedRemote | null {
    const allowedSchemes = readDetectedProviderAllowedSchemes(descriptor);
    const providerBaseUrl = parseUrlWithAllowedScheme(provider.baseUrl, allowedSchemes);
    if (
        !providerBaseUrl
        || providerBaseUrl.username
        || providerBaseUrl.password
        || providerBaseUrl.search
        || providerBaseUrl.hash
        || !isProviderBaseAllowedByDescriptor(providerBaseUrl, descriptor)
    ) {
        return null;
    }
    const repositoryWebUrl = resolveDetectedRepositoryWebUrl(provider, descriptor);
    const declaredKind = ScmHostingProviderKindSchema.safeParse(descriptor.kind);
    const canonicalKind = declaredKind.success ? declaredKind.data : 'custom';
    const normalizedBaseUrl = providerBaseUrl.toString().replace(/\/+$/, '');
    return Object.freeze({
        id: descriptor.id,
        kind: canonicalKind === 'custom' ? 'unknown' : canonicalKind,
        ...(canonicalKind === 'custom' ? { providerKind: 'custom' } : {}),
        displayName: descriptor.displayName,
        name: descriptor.displayName,
        baseUrl: normalizedBaseUrl,
        ...(repositoryWebUrl ? { repositoryWebUrl } : {}),
        ...(provider.nameWithOwner ? { nameWithOwner: provider.nameWithOwner } : {}),
        ...(provider.remoteName !== undefined ? { remoteName: provider.remoteName } : {}),
        urlSafety: Object.freeze({
            allowedSchemes: Object.freeze([...allowedSchemes]),
            allowedBaseUrls: Object.freeze([normalizedBaseUrl]),
            allowedOrigins: Object.freeze([providerBaseUrl.origin]),
        }),
    });
}

function resolveSafeCompareUrl(
    value: string,
    provider: ScmHostingProviderResolvedRemote,
    descriptor: ResolvedScmHostingProvider,
): string | null {
    const allowedSchemes = readDetectedProviderAllowedSchemes(descriptor);
    const compareUrl = parseUrlWithAllowedScheme(value, allowedSchemes);
    const providerBaseUrl = parseUrlWithAllowedScheme(provider.baseUrl, allowedSchemes);
    if (!compareUrl || !providerBaseUrl) return null;
    if (
        compareUrl.username
        || compareUrl.password
        || compareUrl.search
        || compareUrl.hash
        || providerBaseUrl.username
        || providerBaseUrl.password
        || providerBaseUrl.search
        || providerBaseUrl.hash
        || !isProviderBaseAllowedByDescriptor(providerBaseUrl, descriptor)
        || !isUrlWithinBaseUrl(compareUrl, providerBaseUrl)
    ) {
        return null;
    }
    return compareUrl.toString().replace(/\/+$/, '');
}

export function createScmHostingProviderRegistry(params: Readonly<{
    providers: readonly ScmHostingProviderDescriptor[];
    runtimeRegistrations?: readonly ScmHostingProviderRuntimeBinding[];
}>): ResolvedScmHostingProviderRegistry {
    const diagnostics: ScmHostingProviderRegistryDiagnostic[] = [];
    const providersById = new Map<string, ResolvedScmHostingProvider>();
    const runtimeByProviderId = new Map<string, ScmHostingProviderRuntimeBinding>();

    const qualify = (pluginId: string | undefined, localId: string): string => (
        pluginId ? `${pluginId}/${localId}` : localId
    );

    for (const binding of params.runtimeRegistrations ?? []) {
        const qualifiedId = qualify(binding.pluginId, binding.registration.id);
        const existing = runtimeByProviderId.get(qualifiedId);
        if (existing) {
            diagnostics.push(createDuplicateScmHostingProviderDiagnostic({
                existingPluginId: existing.pluginId,
                pluginId: binding.pluginId,
                providerId: binding.registration.id,
            }));
            continue;
        }
        runtimeByProviderId.set(qualifiedId, binding);
    }

    for (const provider of params.providers) {
        const qualifiedId = qualify(provider.pluginId, provider.id);
        const existing = providersById.get(qualifiedId);
        if (existing) {
            diagnostics.push(createDuplicateScmHostingProviderDiagnostic({
                existingPluginId: existing.pluginId,
                pluginId: provider.pluginId,
                providerId: provider.id,
            }));
            continue;
        }
        const runtime = runtimeByProviderId.get(qualifiedId);
        if (runtime && provider.pluginId && provider.pluginId !== runtime.pluginId) {
            diagnostics.push(createScmHostingProviderPluginMismatchDiagnostic({
                descriptorPluginId: provider.pluginId,
                registrationPluginId: runtime.pluginId,
                providerId: provider.id,
            }));
            providersById.set(qualifiedId, Object.freeze({
                ...provider,
                id: qualifiedId,
                urlSafety: readScmHostingProviderUrlSafety(provider),
            }));
            continue;
        }

        providersById.set(qualifiedId, Object.freeze({
            ...provider,
            id: qualifiedId,
            urlSafety: readScmHostingProviderUrlSafety(provider),
            ...(runtime ? { runtime } : {}),
        }));
    }

    for (const binding of params.runtimeRegistrations ?? []) {
        if (!providersById.has(qualify(binding.pluginId, binding.registration.id))) {
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
            const runtime = providersById.get(id)?.runtime;
            return runtime ? bindRuntimeAdapter(runtime) : undefined;
        },
        detectRemote(input) {
            for (const provider of providers) {
                try {
                    const adapter = provider.runtime?.registration.adapter;
                    if (!isScmHostingProviderDetectionAdapter(adapter)) {
                        continue;
                    }
                    const detected = adapter.detectRemote(input);
                    if (!detected) {
                        continue;
                    }
                    const normalized = normalizeDetectedProvider(detected, provider);
                    if (!normalized) {
                        continue;
                    }
                    return Object.freeze({
                        kind: 'resolved' as const,
                        providerId: provider.id,
                        provider: normalized,
                    });
                } catch {
                    // A single plugin-owned detector must not block unrelated providers.
                    continue;
                }
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
            const descriptor = providersById.get(provider.id);
            let adapter: ScmHostingProviderRuntimeAdapter | undefined;
            try {
                adapter = descriptor?.runtime?.registration.adapter;
            } catch {
                adapter = undefined;
            }
            if (!descriptor || !isScmHostingProviderCompareAdapter(adapter)) {
                return Object.freeze({
                    kind: 'unsupported' as const,
                    reason: 'adapter_unavailable' as const,
                    provider,
                });
            }
            let url: string | null;
            try {
                const candidate = adapter.buildCompareUrl({
                    provider,
                    base: input.base,
                    head: input.head,
                });
                url = candidate ? resolveSafeCompareUrl(candidate, provider, descriptor) : null;
            } catch {
                url = null;
            }
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
