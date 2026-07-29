import {
  TranscriptRawAgentEventV1Schema,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  commitSessionStoredMessage,
  fetchSessionById,
} from '@/session/transport/http/sessionsHttp';

import type { ConnectedServiceQuotaLifecycleTransition } from './ConnectedServiceQuotasCoordinator';
import { buildQuotaLifecycleTranscriptEventId } from './quotaLifecycleEventIdentity';

function buildStoredContent(params: Readonly<{
  credentials: Credentials;
  rawSession: Awaited<ReturnType<typeof fetchSessionById>>;
  payload: unknown;
}>): SessionStoredMessageContent {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession ?? undefined);
  if (mode === 'plain') {
    return { t: 'plain', v: params.payload };
  }
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession ?? undefined);
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx, payload: params.payload }),
  };
}

function buildQuotaLifecycleTranscriptEvent(
  transition: ConnectedServiceQuotaLifecycleTransition,
): unknown | null {
  if (transition.phase === 'blocked') {
    if (typeof transition.resetAtMs !== 'number' || !Number.isFinite(transition.resetAtMs) || transition.resetAtMs < 0) {
      return null;
    }
    return {
      type: 'agent-quota-wait',
      serviceId: transition.serviceId,
      ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
      groupId: transition.groupId,
      resetAtMs: Math.trunc(transition.resetAtMs),
      reason: transition.reason,
    };
  }
  return {
    type: 'agent-quota-recovered',
    serviceId: transition.serviceId,
    ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
    groupId: transition.groupId,
    reason: transition.reason,
  };
}

export async function commitConnectedServiceQuotaLifecycleSessionEvents(params: Readonly<{
  credentials: Credentials;
  transition: ConnectedServiceQuotaLifecycleTransition;
}>): Promise<void> {
  const rawEvent = buildQuotaLifecycleTranscriptEvent(params.transition);
  if (rawEvent === null) return;
  const parsedEvent = TranscriptRawAgentEventV1Schema.safeParse(rawEvent);
  if (!parsedEvent.success) return;

  for (const sessionId of params.transition.sessionIds) {
    try {
      const rawSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId,
      });
      if (!rawSession) continue;
      const eventId = buildQuotaLifecycleTranscriptEventId({
        eventType: parsedEvent.data.type,
        issueFingerprint: params.transition.issueFingerprint || `${params.transition.serviceId}:${params.transition.groupId}`,
        resetAtMs: params.transition.resetAtMs,
        cycleId: params.transition.cycleId,
        reason: params.transition.reason,
      });
      await commitSessionStoredMessage({
        token: params.credentials.token,
        sessionId,
        localId: eventId,
        messageRole: 'event',
        content: buildStoredContent({
          credentials: params.credentials,
          rawSession,
          payload: {
            role: 'agent',
            content: {
              type: 'event',
              id: eventId,
              data: parsedEvent.data,
            },
          },
        }),
      });
    } catch {
      // Transcript lifecycle markers are best-effort; one failed session must not
      // block other sessions or the quota refresh path.
    }
  }
}
