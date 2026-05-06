import {
    createDuplicateScmHostingProviderDiagnostic,
    createMissingScmHostingProviderDescriptorDiagnostic,
    createScmHostingProviderPluginMismatchDiagnostic,
} from './diagnostics';
import { readScmHostingProviderUrlSafety } from './urlSafety';
import type {
    ResolvedScmHostingProvider,
    ResolvedScmHostingProviderRegistry,
    ScmHostingProviderDescriptor,
    ScmHostingProviderResolvedRemote,
    ScmHostingProviderRoutingAdapter,
    ScmHostingProviderRuntimeBinding,
    UnresolvedScmHostingProvider,
} from './types';

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

function isUnresolvedScmHostingProvider(provider: Readonly<{ id: string; kind: string }>): provider is UnresolvedScmHostingProvider {
    return provider.id === 'unknown' && provider.kind === 'unknown';
}

function normalizeDetectedProvider(provider: ScmHostingProviderResolvedRemote): ScmHostingProviderResolvedRemote {
    return Object.freeze({
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        ...(provider.nameWithOwner ? { nameWithOwner: provider.nameWithOwner } : {}),
        ...(provider.remoteName !== undefined ? { remoteName: provider.remoteName } : {}),
        ...(provider.urlSafety ? { urlSafety: provider.urlSafety } : {}),
    });
}

export function createScmHostingProviderRegistry(params: Readonly<{
    providers: readonly ScmHostingProviderDescriptor[];
    runtimeRegistrations?: readonly ScmHostingProviderRuntimeBinding[];
}>): ResolvedScmHostingProviderRegistry {
    const diagnostics: ResolvedScmHostingProviderRegistry['diagnostics'][number][] = [];
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
                const detected = adapter.detectRemote(input) as ScmHostingProviderResolvedRemote | null;
                if (!detected) {
                    continue;
                }
                return Object.freeze({
                    kind: 'resolved' as const,
                    providerId: provider.id,
                    provider: normalizeDetectedProvider(detected),
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
