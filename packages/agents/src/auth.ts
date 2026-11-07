import { isPluginAgentCliAuthBackgroundCheckSafe } from '@happier-dev/protocol/plugins/contributions/agentCliMetadata';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import { AGENT_IDS, isBundledAgentId, type AgentId } from './types.js';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@happier-dev/protocol/capabilities';

/**
 * The strict Agent manifest is the only owner of whether an automatic auth
 * check is safe. No parser, argv, or generated auth-probe catalog survives
 * this projection.
 */
export function isAgentCliAuthBackgroundCheckSafe(agentId: AgentId): boolean {
  if (!isBundledAgentId(agentId)) return false;
  const definition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
  return definition?.cli !== undefined && isPluginAgentCliAuthBackgroundCheckSafe(definition.cli);
}

/** The incumbent Machine details/Tools probe, including only safe background sign-in checks. */
export function buildMachineDetailsCapabilitiesDetectRequest(): CapabilitiesDetectRequest {
  const overrides: NonNullable<CapabilitiesDetectRequest['overrides']> = {};
  for (const agentId of AGENT_IDS) {
    if (isAgentCliAuthBackgroundCheckSafe(agentId)) overrides[`cli.${agentId}`] = { params: { includeLoginStatus: true } };
  }
  return { checklistId: CHECKLIST_IDS.MACHINE_DETAILS, overrides };
}
