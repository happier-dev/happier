import type { AgentId } from '@/agents/catalog/catalog';

export type MergedProviderProjectionEntry = Readonly<{
    providerId: string;
    title?: string | null;
    subtitle?: string | null;
    channel?: 'stable' | 'experimental' | 'plugin' | null;
    isBuiltIn?: boolean;
    settingsBackendId?: string | null;
    providerAgentId?: AgentId | null;
    iconAgentId?: AgentId | null;
}>;

export type MergedBackendProjectionEntry = Readonly<{
    backendId: string;
    providerId: string;
    title?: string | null;
    subtitle?: string | null;
    providerAgentId?: AgentId | null;
    iconAgentId?: AgentId | null;
}>;
