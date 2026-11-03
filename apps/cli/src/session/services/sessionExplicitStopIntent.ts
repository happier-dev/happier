import { type SessionStopIntent } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildSessionStopHoldV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { randomUUID } from 'node:crypto';
import {
  clearSessionExplicitStopV1FromMetadata,
  readSessionExplicitStopV1FromMetadata,
  resolveSessionExplicitControlIntent,
  writeSessionExplicitStopV1ToMetadata,
} from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import type { StoredCredentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

export { resolveSessionExplicitControlIntent } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

/** One admission for source Resume and the native launch recheck. */
export function resolveSessionResumeControlIntent(input: Parameters<typeof resolveSessionExplicitControlIntent>[0] & Readonly<{
  rawSession: RawSessionRecord;
  metadata: unknown;
}>): 'person' | 'manager' | 'automatic' | 'session_archived' | 'held_by_person' | 'authority_unavailable' {
  if (input.rawSession.archivedAt !== null && input.rawSession.archivedAt !== undefined) return 'session_archived';
  const stop = readSessionExplicitStopV1FromMetadata(input.metadata);
  if (stop && 'status' in stop) return 'authority_unavailable';
  // Resume retains its direct-manager/person-hold policy; this is not the
  // three-Action led-subtree lifecycle scope owned by dispatch and Home.
  const caller = input.actionContext?.actionCaller;
  if (caller?.kind === 'session' && readSessionManagerSessionIdV1(input.rawSession) !== caller.sessionId) return 'authority_unavailable';
  const intent = resolveSessionExplicitControlIntent(input);
  if (intent === 'unauthorized' || intent === 'self_stop_forbidden') return 'authority_unavailable';
  if (stop && (intent === 'automatic' || intent === 'manager' && !stop.managerSessionId)) return 'held_by_person';
  return intent;
}

export async function recordSessionExplicitStopIntent(input: Readonly<{
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  sessionId: string;
  requestId?: string;
  actionContext?: ActionExecutorContext;
  resolveAuthorizationHeaders?: Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders'];
  accountEncryptionCurrentness?: Parameters<typeof updateSessionMetadataWithRetry>[0]['accountEncryptionCurrentness'];
  currentness?: Parameters<typeof updateSessionMetadataWithRetry>[0]['currentness'];
  signal?: AbortSignal;
}>): Promise<void> {
  const intent = resolveSessionExplicitControlIntent(input);
  if (intent === 'automatic' || intent === 'unauthorized' || intent === 'self_stop_forbidden') throw new Error('Explicit Stop caller unavailable');
  const stop = { v: 1, cause: 'explicit_stop', requestId: input.requestId ?? randomUUID(), requestedAtMs: Date.now(),
    ...(intent === 'manager' && input.actionContext?.actionCaller?.kind === 'session'
      ? { managerSessionId: input.actionContext.actionCaller.sessionId } : {}),
  } as const;
  await updateSessionMetadataWithRetry({
    token: input.credentials.token,
    credentials: input.credentials,
    sessionId: input.sessionId,
    rawSession: input.rawSession,
    ...(input.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: (
      request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0],
    ) => {
      const headers = input.resolveAuthorizationHeaders?.(request);
      if (!headers) throw new Error('Explicit Stop metadata authorization unavailable');
      return headers;
    } } : {}),
    ...(input.accountEncryptionCurrentness ? { accountEncryptionCurrentness: input.accountEncryptionCurrentness } : {}),
    ...(input.currentness || input.signal ? { currentness: { ...input.currentness,
      ...(input.signal ? { signal: input.signal } : {}),
    } } : {}),
    updater: metadata => writeSessionExplicitStopV1ToMetadata(metadata, stop),
  });
}

export async function clearSessionExplicitStopIntentAfterResume(input: Readonly<{
  credentials: StoredCredentials;
  rawSession?: RawSessionRecord;
  sessionId: string;
  metadata: Record<string, unknown>;
  resolveAuthorizationHeaders?: Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders'];
  currentness?: Parameters<typeof updateSessionMetadataWithRetry>[0]['currentness'];
}>): Promise<void> {
  const stop = readSessionExplicitStopV1FromMetadata(input.metadata);
  if (!stop || 'status' in stop) return;
  const rawSession = input.rawSession ?? await fetchSessionByIdCompat({
    reason: 'session-control',
    token: input.credentials.token,
    sessionId: input.sessionId,
    ...(input.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: input.resolveAuthorizationHeaders } : {}),
    ...(input.currentness?.signal ? { signal: input.currentness.signal } : {}),
  });
  if (!rawSession || rawSession.id !== input.sessionId) throw new Error('Exact resumed Session metadata is unavailable');
  await updateSessionMetadataWithRetry({
    token: input.credentials.token,
    credentials: input.credentials,
    sessionId: input.sessionId,
    rawSession,
    ...(input.currentness ? { currentness: input.currentness } : {}),
    ...(input.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: (
      request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0],
    ) => {
      const headers = input.resolveAuthorizationHeaders?.(request);
      if (!headers) throw new Error('Explicit Stop metadata authorization unavailable');
      return headers;
    } } : {}),
    updater: metadata => clearSessionExplicitStopV1FromMetadata(metadata, stop.requestId),
  });
}

export async function recordSessionStopIntent(input: Readonly<{
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  sessionId: string;
  requestId?: string;
  actionContext?: ActionExecutorContext;
  stopIntent: SessionStopIntent;
  resolveAuthorizationHeaders?: Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders'];
  accountEncryptionCurrentness?: Parameters<typeof updateSessionMetadataWithRetry>[0]['accountEncryptionCurrentness'];
  currentness?: Parameters<typeof updateSessionMetadataWithRetry>[0]['currentness'];
  signal?: AbortSignal;
}>): Promise<void> {
  const hold = buildSessionStopHoldV1({ ...input, requestId: input.requestId ?? randomUUID(), requestedAtMs: Date.now() });
  if (hold.kind === 'refused') throw new Error('Explicit Stop caller unavailable');
  // A lifecycle Stop never writes or clears a hold, including an existing
  // person's hold. Physical Stop/currentness remains with the caller's owner.
  if (hold.kind === 'no_hold') return;
  await updateSessionMetadataWithRetry({
    token: input.credentials.token,
    credentials: input.credentials,
    sessionId: input.sessionId,
    rawSession: input.rawSession,
    ...(input.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: (
      request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0],
    ) => {
      const headers = input.resolveAuthorizationHeaders?.(request);
      if (!headers) throw new Error('Explicit Stop metadata authorization unavailable');
      return headers;
    } } : {}),
    ...(input.accountEncryptionCurrentness ? { accountEncryptionCurrentness: input.accountEncryptionCurrentness } : {}),
    ...(input.currentness || input.signal ? { currentness: { ...input.currentness,
      ...(input.signal ? { signal: input.signal } : {}),
    } } : {}),
    updater: metadata => writeSessionExplicitStopV1ToMetadata(metadata, hold.stop),
  });
}
