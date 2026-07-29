import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import type {
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from './types';

const BUILT_IN_AGENT_ID_SET = new Set<string>(AGENT_IDS);

export function normalizeBuiltInAgentId(value: unknown): AgentId | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return BUILT_IN_AGENT_ID_SET.has(normalized) ? normalized as AgentId : null;
}

function readPluginCompatibilityAgentId(
    richDefinition: ResolvedAgentRuntimeContribution['richDefinition'] | ResolvedAgentContribution['richDefinition'] | undefined,
): AgentId | null {
    if (richDefinition?.provenance !== 'external') return null;
    const definition = richDefinition.definition as Readonly<{ catalogAgentId?: unknown }>;
    return normalizeBuiltInAgentId(definition.catalogAgentId);
}

export function resolveContributionCatalogAgentId(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
}>): AgentId | null {
    const explicitCompatibilityAgentId = readPluginCompatibilityAgentId(params.backend.richDefinition)
        ?? readPluginCompatibilityAgentId(params.agent.richDefinition);
    if (params.backend.provenance === 'external' || params.agent.provenance === 'external') {
        return explicitCompatibilityAgentId;
    }
    return explicitCompatibilityAgentId
        ?? normalizeBuiltInAgentId(params.agent.id)
        ?? normalizeBuiltInAgentId(params.backend.agentId);
}
