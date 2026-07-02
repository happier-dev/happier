import { randomUUID } from 'node:crypto';

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

function normalizeEventIdPart(value: string | null | undefined): string {
  const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'none';
  return normalized.replace(/[^a-zA-Z0-9._:-]+/gu, '_');
}

function parseRuntimeAuthRecoveryEvent(
  value: unknown,
): ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1 | null {
  const parsed = TranscriptRawAgentEventV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.type !== 'connected-service-runtime-auth-recovery') return null;
  return parsed.data;
}

export async function commitConnectedServiceRuntimeAuthRecoverySessionEvent(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  event: unknown;
}>): Promise<void> {
  const event = parseRuntimeAuthRecoveryEvent(params.event);
  if (!event) return;

  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) return;

  const eventId = [
    'connected-service-runtime-auth-recovery',
    normalizeEventIdPart(event.serviceId),
    normalizeEventIdPart(event.groupId),
    normalizeEventIdPart(event.profileId),
    normalizeEventIdPart(event.status),
    randomUUID(),
  ].join(':');

  await commitSessionStoredMessage({
    token: params.credentials.token,
    sessionId: params.sessionId,
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
          data: event,
        },
      },
    }),
  });
}
