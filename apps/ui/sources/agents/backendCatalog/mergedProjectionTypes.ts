import type { AgentId } from '@/agents/catalog/catalog';
import type {
    PluginAgentCliMetadata,
    AgentUiProjectedDeclarationV1,
    PluginContributionIdentityV1,
    PluginProjectedAgentConnectedAccountPurposeV2,
    PluginProjectionInstalledPackageV2,
} from '@happier-dev/protocol';

export type MergedBackendCapabilities = Readonly<{
    executionRun?: unknown;
    session?: Readonly<{
        supported?: boolean;
    }> | null;
}> & Readonly<Record<string, unknown>>;

export type MergedProviderProjectionEntry = Readonly<{
    agentId: string;
    /** Exact V2 registry key; unlike a local id this remains collision-free. */
    qualifiedId?: string | null;
    identity?: PluginContributionIdentityV1 | null;
    /** Package facts captured from the same V2 projection as this Agent. */
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    /** Daemon projection generation paired with `installedPackage`. */
    projectionGeneration?: number | null;
    title?: string | null;
    subtitle?: string | null;
    channel?: 'stable' | 'experimental' | 'plugin' | null;
    isBuiltIn?: boolean;
    settingsBackendId?: string | null;
    catalogAgentId?: AgentId | null;
    iconAgentId?: AgentId | null;
    cli?: PluginAgentCliMetadata | null;
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[] | null;
    /**
     * The Agent's own UI-behavior descriptor as projected by the daemon. It
     * feeds the client's single descriptor interpreter; a bundled Agent keeps
     * reaching that interpreter through its build-time projection instead.
     */
    ui?: AgentUiProjectedDeclarationV1 | null;
}>;

export type MergedBackendProjectionEntry = Readonly<{
    backendId: string;
    agentId: string;
    title?: string | null;
    subtitle?: string | null;
    catalogAgentId?: AgentId | null;
    iconAgentId?: AgentId | null;
    capabilities?: MergedBackendCapabilities | null;
}>;
