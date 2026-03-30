import { deriveNewAgentRequests } from '@/sync/domains/permissions/deriveNewAgentRequests';
import type { Session } from '@/sync/domains/state/storageTypes';
import { voiceHooks } from './voiceHooks';

type SessionLike = Pick<Session, 'id' | 'agentState'> | null | undefined;

export function reportNewAgentRequestsFromSessionTransition(
  previousSession: SessionLike,
  nextSession: SessionLike,
): void {
  const sessionId = String(nextSession?.id ?? '').trim();
  if (!sessionId) return;

  for (const nextRequest of deriveNewAgentRequests(previousSession?.agentState?.requests, nextSession?.agentState?.requests)) {
    voiceHooks.onAgentRequest(
      sessionId,
      nextRequest.requestId,
      nextRequest.requestKind,
      nextRequest.toolName,
      nextRequest.toolArgs,
    );
  }
}
