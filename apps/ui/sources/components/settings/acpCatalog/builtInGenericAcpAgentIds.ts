import { AGENT_IDS, hasBuiltInAcpConfig, type AgentId } from '@happier-dev/agents';

/**
 * Built-in definitions shown in the generic ACP catalog settings surface.
 * First-class providers own their own settings rows, while Custom ACP is the
 * user-defined family managed by the editable catalog below this list.
 */
export function getBuiltInGenericAcpAgentIds(): readonly AgentId[] {
    return AGENT_IDS.filter((agentId) => agentId !== 'customAcp' && hasBuiltInAcpConfig(agentId));
}
