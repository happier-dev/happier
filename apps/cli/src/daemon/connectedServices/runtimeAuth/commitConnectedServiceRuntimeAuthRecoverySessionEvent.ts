import { createHash } from 'node:crypto';
import {
  TranscriptRawAgentEventV1Schema,
  agentEventAttentionImpact,
  buildAgentEventLocalId,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './projection/connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  commitSessionStoredMessage,
  fetchSessionById,
} from '@/session/transport/http/sessionsHttp';

import type { ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 } from './projection/connectedServiceRuntimeAuthRecoveryProjection';

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

function parseRuntimeAuthRecoveryEvent(
  value: unknown,
): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 | null {
  const parsed = TranscriptRawAgentEventV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.type !== 'connected-service-runtime-auth-recovery') return null;
  return parsed.data;
}

function buildRuntimeAuthRecoveryTranscriptEventId(
  event: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1,
): string {
  return buildAgentEventLocalId('connected-service-runtime-auth-recovery', [
    event.serviceId,
    event.groupId ?? 'none',
    event.profileId ?? 'none',
    event.status,
    event.attempt ?? 'none',
    typeof event.terminal === 'boolean' ? String(event.terminal) : 'none',
    event.reason ?? 'none',
  ]);
}

export function buildRuntimeAuthRecoveryAttemptTransitionLocalId(input: Readonly<{
  attemptId: string;
  transition: string;
}>): string {
  const attemptDigest = createHash('sha256').update(input.attemptId).digest('base64url');
  return buildAgentEventLocalId('connected-service-runtime-auth-recovery', [
    attemptDigest,
    input.transition,
  ]);
}

export async function commitConnectedServiceRuntimeAuthRecoverySessionEvent(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  event: unknown;
  attemptId?: string;
  transition?: string;
  recoveryIntent?: RuntimeAuthRecoveryIntent;
}>): Promise<void> {
  const event = parseRuntimeAuthRecoveryEvent(params.event);
  if (!event) return;

  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) {
    const error = new Error('Runtime-auth recovery session not found');
    (error as { code?: string }).code = 'runtime_auth_recovery_session_not_found';
    throw error;
  }

  const updater = params.recoveryIntent
    ? buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: params.recoveryIntent })
    : null;
  if (updater) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      updater,
    });
  }

  const eventId = params.attemptId && params.transition
    ? buildRuntimeAuthRecoveryAttemptTransitionLocalId({
        attemptId: params.attemptId,
        transition: params.transition,
      })
    : buildRuntimeAuthRecoveryTranscriptEventId(event);

  await commitSessionStoredMessage({
    token: params.credentials.token,
    sessionId: params.sessionId,
    localId: eventId,
    messageRole: 'event',
    attentionImpact: agentEventAttentionImpact(event, eventId),
    content: buildStoredContent({
      credentials: params.credentials,
      rawSession,
      payload: {
        role: 'agent',
        content: {
          type: 'event',
          id: eventId,
          data: event,
        },
      },
    }),
  });
}
