import type { Session } from '@/sync/domains/state/storageTypes';
import { evaluateAgentSessionCapabilitySupport, inferAgentIdFromSessionMetadata } from '@happier-dev/agents';

export type SessionForkSupportSource = Pick<Session, 'metadata' | 'serverId'>;

export function canForkConversation(params: { session: SessionForkSupportSource | null | undefined; replayEnabled: boolean | null | undefined }): boolean {
  const session = params.session ?? null;
  if (!session) return false;
  if (params.replayEnabled === true) return true;
  const agentId = inferAgentIdFromSessionMetadata(session.metadata);
  return evaluateAgentSessionCapabilitySupport({
    agentId,
    capability: 'sessionFork.conversation',
    metadata: session.metadata,
  }) === 'supported';
}

export function canForkFromMessage(params: {
  session: SessionForkSupportSource | null | undefined;
  messageSeq: number | null;
  replayEnabled: boolean | null | undefined;
}): boolean {
  const session = params.session ?? null;
  if (!session) return false;
  if (params.messageSeq == null || !Number.isFinite(params.messageSeq) || params.messageSeq <= 0) return false;
  if (params.replayEnabled === true) return true;
  const agentId = inferAgentIdFromSessionMetadata(session.metadata);
  return evaluateAgentSessionCapabilitySupport({
    agentId,
    capability: 'sessionFork.fromMessage',
    metadata: session.metadata,
  }) === 'supported';
}
