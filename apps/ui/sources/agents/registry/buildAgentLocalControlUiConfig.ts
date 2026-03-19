import { getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentLocalControlUiConfig(params: Readonly<{
    agentId: AgentId;
}>): AgentCoreConfig['localControl'] {
    const localControl = getAgentLocalControlCapability(params.agentId);
    if (!localControl) return undefined;
    return {
        supported: true,
        topology: localControl.topology,
        attachStrategy: localControl.attachStrategy,
    };
}
