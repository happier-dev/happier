import type {
  ExternalSessionsAgentId,
  PluginAgentExternalLinkedTakeoverWriterSafetyV1,
  PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
  resolveCurrentExternalSessionAgentRoutingId,
} from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';

/**
 * Reads the current Agent generation's static continuing-writer disposition.
 * Missing or retired evidence is never inferred from Agent identity.
 */
export async function resolveExternalLinkedTakeoverWriterSafety(
  agentId: ExternalSessionsAgentId,
): Promise<PluginAgentExternalLinkedTakeoverWriterSafetyV1> {
  const surface = (await getSessionHostBridge().resolveExecutionSurfaces(agentId)).externalSession;
  return surface?.externalLinkedTakeoverWriterSafety ?? 'unsupported';
}

/**
 * Same disposition, addressed by the durable `{pluginId, localId}` Agent
 * identity that External Sessions operation records persist. The execution
 * surface is keyed by the host routing id, and only the plugin registry maps
 * an identity onto it, so an identity the current catalog no longer
 * contributes reads as `unsupported` instead of being probed under a
 * fabricated id.
 */
export async function resolveExternalLinkedTakeoverWriterSafetyForAgentIdentity(
  agent: PluginContributionIdentityV1,
): Promise<PluginAgentExternalLinkedTakeoverWriterSafetyV1> {
  const agentId = await resolveCurrentExternalSessionAgentRoutingId(agent);
  return agentId
    ? await resolveExternalLinkedTakeoverWriterSafety(agentId)
    : 'unsupported';
}
