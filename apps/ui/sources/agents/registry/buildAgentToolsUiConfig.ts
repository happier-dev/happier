import { getAgentCore, type BundledAgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentToolsUiConfig(params: Readonly<{
    agentId: BundledAgentId;
}>): AgentCoreConfig['tools'] {
    const tools = getAgentCore(params.agentId).tools;
    return {
        delivery: tools?.delivery ?? 'unsupported',
        support: tools?.support ?? 'unsupported',
    };
}
