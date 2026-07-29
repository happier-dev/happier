import type {
  ExternalSessionsAgentId,
  PluginAgentExternalLinkedTakeoverWriterSafetyV1,
} from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

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
