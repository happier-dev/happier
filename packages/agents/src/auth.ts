import { isPluginAgentCliAuthBackgroundCheckSafe } from '@happier-dev/protocol';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import { isBundledAgentId, type AgentId } from './types.js';

/**
 * The strict Agent manifest is the only owner of whether an automatic auth
 * check is safe. No parser, argv, or generated auth-probe catalog survives
 * this projection.
 */
export function isAgentCliAuthBackgroundCheckSafe(agentId: AgentId): boolean {
  if (!isBundledAgentId(agentId)) return false;
  const definition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
  return definition !== undefined && isPluginAgentCliAuthBackgroundCheckSafe(definition.cli);
}
