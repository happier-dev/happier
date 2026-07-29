import type { ResolvedScmBackendContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { StablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';

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
    envAllowedNamesByPluginId?: ResolvedExecutablePluginRuntimeRegistry['envAllowedNamesByPluginId'];
    resolveConnectedAccountPurposeBindingOwner?:
        ResolvedExecutablePluginRuntimeRegistry['resolveConnectedAccountPurposeBindingOwner'];
    managedDependencies?: Pick<StablePluginManagedDependenciesHost, 'resolveExecutable'>;
    scmBackendsById?: ResolvedExecutablePluginRuntimeRegistry['scmBackendsById'];
    scmBackendRegistrations?: ResolvedExecutablePluginRuntimeRegistry['scmBackendRegistrations'];
}>;

export function createPluginScmBackendsFromRuntimeRegistry(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): readonly ScmBackend[] {
    return createPluginScmBackendRegistryFromRuntimeRegistry(runtimeRegistry).backends;
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
            envAllowedNamesByPluginId: runtimeRegistry.envAllowedNamesByPluginId,
            resolveConnectedAccountPurposeBindingOwner:
                runtimeRegistry.resolveConnectedAccountPurposeBindingOwner,
            managedDependencies: runtimeRegistry.managedDependencies,
        }),
    });
}
