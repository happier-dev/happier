import type { ResolvedScmBackendContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import { createHostScmHostingProviderRuntimeServices } from '../hostingProviders/runtimeServices';
import type { ScmBackend } from '../types';
import {
    createRegisteredScmBackendRegistry,
    type RegisteredScmBackendActivation,
    type RegisteredScmBackendDefinition,
} from './registeredScmBackendRegistry';

export type ScmBackendPluginRuntimeRegistry = Readonly<{
    contributes: Readonly<{
        scmBackends?: readonly ResolvedScmBackendContribution[];
        scmHostingProviders?: ResolvedExecutablePluginRuntimeRegistry['contributes']['scmHostingProviders'];
        connectedAccountDescriptors?: ResolvedExecutablePluginRuntimeRegistry['contributes']['connectedAccountDescriptors'];
    }>;
    scmHostingProvidersById?: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
    scmBackendsById?: ResolvedExecutablePluginRuntimeRegistry['scmBackendsById'];
    scmBackendRegistrations?: ResolvedExecutablePluginRuntimeRegistry['scmBackendRegistrations'];
    activatePluginsByEvent?: ResolvedExecutablePluginRuntimeRegistry['activatePluginsByEvent'];
}>;

export function createPluginScmBackendsFromRuntimeRegistry(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): readonly ScmBackend[] {
    return createPluginScmBackendRegistryFromRuntimeRegistry(runtimeRegistry).backends;
}

/**
 * Fires the `onScmProvider:<id>` lazy activation event for every declared SCM
 * backend / hosting-provider contribution.
 *
 * scm-git and scm-sapling (and the other first-party SCM plugins) declare
 * `activationEvents: ['onScmProvider:<id>']` rather than `startup`, so their
 * runtime registration only exists once this event has fired for their id.
 * ANY consumer that materializes SCM backends or reads SCM-backend
 * diagnostics from a `ScmBackendPluginRuntimeRegistry` MUST call this first —
 * otherwise event-gated plugins look unregistered ("missing activation")
 * even though they are correctly wired and simply haven't been asked to
 * activate yet. This is the single canonical place that decides which SCM
 * provider ids need activating; do not re-derive it at call sites.
 */
export async function activateScmProviderRuntimeEvents(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): Promise<void> {
    if (!runtimeRegistry.activatePluginsByEvent) {
        return;
    }
    const providerIds = new Set<string>();
    for (const contribution of runtimeRegistry.contributes.scmBackends ?? []) {
        providerIds.add(contribution.definition.id);
    }
    for (const contribution of runtimeRegistry.contributes.scmHostingProviders ?? []) {
        providerIds.add(contribution.definition.id);
    }
    await Promise.all([...providerIds].sort().map((providerId) => (
        runtimeRegistry.activatePluginsByEvent?.(`onScmProvider:${providerId}`)
    )));
}

export function createPluginScmBackendRegistryFromRuntimeRegistry(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): Readonly<{
    backends: readonly ScmBackend[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const definitions: RegisteredScmBackendDefinition[] = (runtimeRegistry.contributes.scmBackends ?? [])
        .flatMap((entry) => {
            if (!entry.pluginId) {
                return [];
            }
            return [{
                pluginId: entry.pluginId,
                contributionId: entry.definition.id,
                definition: entry.definition,
            }];
        });
    const activationEntries = runtimeRegistry.scmBackendRegistrations
        ?? [...(runtimeRegistry.scmBackendsById ?? new Map()).values()];
    const registrations: RegisteredScmBackendActivation[] = activationEntries
        .map((entry) => ({
            pluginId: entry.pluginId,
            registration: entry.registration,
        }));

    return createRegisteredScmBackendRegistry({
        definitions,
        registrations,
        hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({
            contributes: runtimeRegistry.contributes,
            scmHostingProvidersById: runtimeRegistry.scmHostingProvidersById ?? new Map(),
        }),
    });
}
