import {
    createDuplicateScmHostingProviderDiagnostic,
    createMissingScmHostingProviderDescriptorDiagnostic,
    createScmHostingProviderPluginMismatchDiagnostic,
} from './diagnostics';
import { readScmHostingProviderAllowedSchemes } from './urlSafety';
import type {
    ResolvedScmHostingProvider,
    ResolvedScmHostingProviderRegistry,
    ScmHostingProviderDescriptor,
    ScmHostingProviderRuntimeBinding,
} from './types';

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
                urlSafety: {
                    allowedSchemes: readScmHostingProviderAllowedSchemes(provider),
                },
            }));
            continue;
        }

        providersById.set(provider.id, Object.freeze({
            ...provider,
            urlSafety: {
                allowedSchemes: readScmHostingProviderAllowedSchemes(provider),
            },
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
    });
}
