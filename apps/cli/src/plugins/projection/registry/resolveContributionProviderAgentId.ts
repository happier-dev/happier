import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import type {
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from './types';

const BUILT_IN_AGENT_ID_SET = new Set<string>(AGENT_IDS);

export function normalizeBuiltInAgentId(value: unknown): AgentId | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return BUILT_IN_AGENT_ID_SET.has(normalized) ? normalized as AgentId : null;
}

function readPluginCompatibilityAgentId(
    richDefinition: ResolvedAgentRuntimeContribution['richDefinition'] | ResolvedAgentContribution['richDefinition'] | undefined,
): AgentId | null {
    if (richDefinition?.provenance !== 'external') {
        return null;
    }
    const definition = richDefinition.definition as Readonly<{
        catalogAgentId?: unknown;
        providerAgentId?: unknown;
    }>;
    return normalizeBuiltInAgentId(definition.catalogAgentId)
        ?? normalizeBuiltInAgentId(definition.providerAgentId);
}

export function resolveContributionProviderAgentId(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
}>): AgentId | null {
    const explicitCompatibilityAgentId = readPluginCompatibilityAgentId(params.backend.richDefinition)
        ?? readPluginCompatibilityAgentId(params.provider.richDefinition);
    if (params.backend.provenance === 'external' || params.provider.provenance === 'external') {
        return explicitCompatibilityAgentId;
    }

    return explicitCompatibilityAgentId
        ?? normalizeBuiltInAgentId(params.provider.id)
        ?? normalizeBuiltInAgentId(params.backend.agentId);
}
