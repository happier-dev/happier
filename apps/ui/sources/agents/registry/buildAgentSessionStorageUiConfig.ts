import { getAgentCore } from '@happier-dev/agents';

import type { AgentId } from './registryCore';

export function buildAgentSessionStorageUiConfig(params: Readonly<{ agentId: AgentId }>) {
    return getAgentCore(params.agentId).sessionStorage;
}
