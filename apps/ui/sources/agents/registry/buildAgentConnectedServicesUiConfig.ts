import { getAgentCore, type BundledAgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

/** Builds one bundled Agent's UI core; the generated entries are its only caller. */
export function buildAgentConnectedServicesUiConfig(params: Readonly<{
    agentId: BundledAgentId;
}>): AgentCoreConfig['connectedServices'] {
    return getAgentCore(params.agentId).connectedServices ?? null;
}
