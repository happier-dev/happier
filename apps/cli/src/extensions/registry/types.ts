import type {
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1,
} from '@happier-dev/agents';
import type { BackendRuntimeAdapterV1, HookRegistrationV1 } from '@happier-dev/protocol';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';

import type { AgentCatalogEntry } from '@/backends/types';
import type { PluginCompatibilityDiagnostic } from '@/extensions/plugins/shared/pluginDiagnostics';

export type ResolvedContributionSource = 'built_in' | 'plugin';
export type ResolvedCatalogEntry = Readonly<
    Omit<AgentCatalogEntry, 'id' | 'cliSubcommand'> & {
        id: string;
        cliSubcommand: string;
    }
>;

export type ResolvedProviderContribution = Readonly<{
    id: string;
    source: ResolvedContributionSource;
    definition: ProviderDefinitionContractV1;
    runtimeSpec?: ProviderCliRuntimeDescriptor | null;
    catalogEntry?: ResolvedCatalogEntry | null;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
}>;

export type ResolvedBackendContribution = Readonly<{
    id: string;
    providerId: string;
    source: ResolvedContributionSource;
    definition: BackendDefinitionContractV1;
    runtimeAdapters?: readonly BackendRuntimeAdapterV1[];
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
}>;

export type ResolvedBackendRuntimeAdapterContribution = Readonly<{
    backendId: string;
    source: ResolvedContributionSource;
    definition: BackendRuntimeAdapterV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
}>;

export type ResolvedHookRegistration = Readonly<{
    source: 'plugin';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    definition: HookRegistrationV1;
}>;

export type ResolvedContributionInputs = Readonly<{
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    hookRegistrations?: readonly ResolvedHookRegistration[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

export type ResolvedContributionRegistry = Readonly<{
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    hookRegistrations: readonly ResolvedHookRegistration[];
    runtimeAdaptersByBackendId: ReadonlyMap<string, readonly ResolvedBackendRuntimeAdapterContribution[]>;
    catalogEntriesById: Readonly<Record<string, ResolvedCatalogEntry>>;
    providerDefinitionsById: ReadonlyMap<string, ResolvedProviderContribution>;
    backendDefinitionsById: ReadonlyMap<string, ResolvedBackendContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
