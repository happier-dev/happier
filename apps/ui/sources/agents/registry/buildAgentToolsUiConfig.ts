import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentToolsUiConfig(params: Readonly<{
    agentId: AgentId;
}>): AgentCoreConfig['tools'] {
    const tools = AGENTS_CORE[params.agentId]?.tools;
    return {
        delivery: tools?.delivery ?? 'unsupported',
        support: tools?.support ?? 'unsupported',
    };
}
