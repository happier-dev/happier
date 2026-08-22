import { getAgentCore } from '@happier-dev/agents';

import type { BundledAgentId } from './registryCore';

export function buildAgentSessionStorageUiConfig(params: Readonly<{ agentId: BundledAgentId }>) {
    return getAgentCore(params.agentId).sessionStorage;
}
