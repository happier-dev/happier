import type { AgentId } from '@/agents/catalog/catalog';
import type {
    PluginAgentCliMetadata,
    PluginAgentUiBehaviorContributionV2,
    PluginContributionIdentityV1,
} from '@happier-dev/protocol';

export type MergedBackendCapabilities = Readonly<{
    executionRun?: unknown;
    session?: Readonly<{
        supported?: boolean;
    }> | null;
}> & Readonly<Record<string, unknown>>;

export type MergedProviderProjectionEntry = Readonly<{
    agentId: string;
    identity?: PluginContributionIdentityV1 | null;
    title?: string | null;
    subtitle?: string | null;
    channel?: 'stable' | 'experimental' | 'plugin' | null;
    isBuiltIn?: boolean;
    settingsBackendId?: string | null;
    catalogAgentId?: AgentId | null;
    iconAgentId?: AgentId | null;
    cli?: PluginAgentCliMetadata | null;
    /**
     * The Agent's own UI-behavior descriptor as projected by the daemon. It
     * feeds the client's single descriptor interpreter; a bundled Agent keeps
     * reaching that interpreter through its build-time projection instead.
     */
    ui?: PluginAgentUiBehaviorContributionV2 | null;
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
