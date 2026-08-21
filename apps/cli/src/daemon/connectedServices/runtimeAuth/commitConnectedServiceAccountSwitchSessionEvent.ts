import {
  ConnectedServiceIdSchema,
  ConnectedServiceUxDiagnosticV1Schema,
  ConnectedServiceSwitchAttemptedContinuityModeV1Schema,
  ConnectedServiceSwitchAttemptOutcomeActionV1Schema,
  ConnectedServiceSwitchAttemptOutcomeV1Schema,
  ConnectedServiceSwitchAttemptSessionAdoptionV1Schema,
  agentEventAttentionImpact,
  buildAgentEventLocalId,
  type ConnectedServiceId,
  type ConnectedServiceUxDiagnosticV1,
  type ConnectedServiceSwitchAttemptedContinuityModeV1,
  type ConnectedServiceSwitchAttemptOutcomeActionV1,
  type ConnectedServiceSwitchAttemptOutcomeV1,
  type ConnectedServiceSwitchAttemptSessionAdoptionV1,
  type SessionStoredMessageContent,
  type TranscriptRawAgentEventV1,
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
import {
  loadConnectedServiceNotificationProfilesById,
  resolveConnectedServiceNotificationProfileLabel,
  type ConnectedServiceNotificationProfileSummary,
} from '../notifications/connectedServiceNotificationLabels';
import { isBackgroundConnectedServiceSwitchReason } from '../connectedServiceSwitchEventVisibility';

type ConnectedServiceRuntimeSwitchSessionEvent = Readonly<{
  type: 'connected_service_account_switch' | 'connected_service_auth_group_switch';
  serviceId: ConnectedServiceId;
  groupId: string | null;
  groupLabel?: string | null;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: string;
  mode: ConnectedServiceAccountSwitchMode;
  generation?: number;
}>;

type ConnectedServiceRuntimeSwitchDeferralSessionEvent = Readonly<{
  type: 'connected_service_account_switch_deferred';
  policy: 'defer_until_turn_boundary' | 'defer_until_idle';
  awaitingBoundary: boolean;
  timeoutMs: number;
}>;

type ConnectedServiceRuntimeSwitchDeferralCompletionSessionEvent = Readonly<{
  type: 'connected_service_account_switch_deferral_completed';
  policy: 'defer_until_turn_boundary' | 'defer_until_idle';
  reason: 'completed_at_boundary' | 'aborted_after_timeout' | 'switch_cancelled' | 'session_terminated' | 'daemon_shutdown';
}>;

type ConnectedServiceRuntimeSwitchDeferralSupersededSessionEvent = Readonly<{
  type: 'connected_service_account_switch_deferral_superseded';
  policy?: 'defer_until_turn_boundary' | 'defer_until_idle';
}>;

type ConnectedServiceRuntimeSwitchAttemptSessionEvent = Readonly<{
  type: 'connected_service_account_switch_attempt';
  ok: boolean;
  action: 'restart_requested' | 'hot_applied' | 'metadata_updated';
  rawReason?: string;
  reason?: TranscriptSwitchReason;
  attemptedContinuityMode?: ConnectedServiceSwitchAttemptedContinuityModeV1;
  outcome?: ConnectedServiceSwitchAttemptOutcomeV1;
  outcomeAction?: ConnectedServiceSwitchAttemptOutcomeActionV1;
  errorCode: string | null;
  diagnostic?: ConnectedServiceUxDiagnosticV1;
  groupGeneration?: number;
  sessionAdoption?: ConnectedServiceSwitchAttemptSessionAdoptionV1;
  sessionAdoptedGeneration?: number;
  partialState: 'metadata_may_reference_new_binding' | 'runtime_auth_applied' | 'runtime_auth_partially_applied' | null;
  verificationByServiceId?: Readonly<Record<string, Readonly<{
    status: 'verified' | 'weakly_verified';
    providerAccountId?: string | null;
    activeAccountId?: string | null;
    sharedAuthSurfaceId?: string | null;
    proofStrength?: 'exact' | 'weak' | 'diagnostic';
    source?: string;
    reason?: string;
  }>>>;
}>;

type ConnectedServiceRuntimeStateSharingDegradedSessionEvent = Readonly<{
  type: 'provider_state_sharing_degraded';
  serviceId: ConnectedServiceId;
  requestedStateMode: string;
  effectiveStateMode: string;
  code: string;
  reason?: string;
  entryName?: string;
}>;

type TranscriptSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failure'
  | 'manual';

type ConnectedServiceAccountSwitchMode =
  | 'hot_apply'
  | 'restart_resume'
  | 'spawn_next_turn';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSwitchMode(value: unknown): ConnectedServiceAccountSwitchMode {
  switch (value) {
    case 'hot_apply':
    case 'restart_resume':
    case 'spawn_next_turn':
      return value;
    default:
      return 'restart_resume';
  }
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const parsed = Math.trunc(value);
  return parsed >= 0 ? parsed : undefined;
}

function parseRuntimeSwitchEvent(value: unknown): ConnectedServiceRuntimeSwitchSessionEvent | null {
  const record = asRecord(value);
  if (
    !record
    || (
      record.type !== 'connected_service_account_switch'
      && record.type !== 'connected_service_auth_group_switch'
    )
  ) return null;
  const serviceId = typeof record.serviceId === 'string' ? record.serviceId.trim() : '';
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
  const rawGroupId = typeof record.groupId === 'string' ? record.groupId.trim() : '';
  const rawGroupLabel = typeof record.groupLabel === 'string' ? record.groupLabel.trim() : '';
  const rawFromProfileId = typeof record.fromProfileId === 'string' ? record.fromProfileId.trim() : '';
  const rawToProfileId = typeof record.toProfileId === 'string' ? record.toProfileId.trim() : '';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (!parsedServiceId.success || (!rawFromProfileId && !rawToProfileId) || !reason) return null;
  const rawGeneration = record.type === 'connected_service_auth_group_switch'
    ? record.toGeneration
    : record.generation;
  const generation = typeof rawGeneration === 'number' && Number.isFinite(rawGeneration)
    ? Math.max(0, Math.trunc(rawGeneration))
    : undefined;
  return {
    type: record.type,
    serviceId: parsedServiceId.data,
    groupId: rawGroupId || null,
    ...(rawGroupLabel ? { groupLabel: rawGroupLabel } : {}),
    fromProfileId: rawFromProfileId || null,
    toProfileId: rawToProfileId || null,
    reason,
    mode: parseSwitchMode(record.mode),
    ...(generation === undefined ? {} : { generation }),
  };
}

function isSameProfileRuntimeSwitchEvent(event: ConnectedServiceRuntimeSwitchSessionEvent): boolean {
  return Boolean(
    event.fromProfileId
    && event.toProfileId
    && event.fromProfileId === event.toProfileId,
  );
}

function parseDeferralPolicy(value: unknown): 'defer_until_turn_boundary' | 'defer_until_idle' | null {
  return value === 'defer_until_turn_boundary' || value === 'defer_until_idle' ? value : null;
}

function parseRuntimeSwitchDeferralEvent(value: unknown): ConnectedServiceRuntimeSwitchDeferralSessionEvent | null {
  const record = asRecord(value);
  if (!record || record.type !== 'connected_service_account_switch_deferred') return null;
  const policy = parseDeferralPolicy(record.policy);
  if (!policy || typeof record.awaitingBoundary !== 'boolean') return null;
  const timeoutMs = typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)
    ? Math.max(0, Math.trunc(record.timeoutMs))
    : 0;
  return {
    type: 'connected_service_account_switch_deferred',
    policy,
    awaitingBoundary: record.awaitingBoundary,
    timeoutMs,
  };
}

function parseRuntimeSwitchDeferralCompletionEvent(value: unknown): ConnectedServiceRuntimeSwitchDeferralCompletionSessionEvent | null {
  const record = asRecord(value);
  if (!record || record.type !== 'connected_service_account_switch_deferral_completed') return null;
  const policy = parseDeferralPolicy(record.policy);
  const reason =
    record.reason === 'completed_at_boundary'
    || record.reason === 'aborted_after_timeout'
    || record.reason === 'switch_cancelled'
    || record.reason === 'session_terminated'
    || record.reason === 'daemon_shutdown'
      ? record.reason
      : null;
  if (!policy || !reason) return null;
  return {
    type: 'connected_service_account_switch_deferral_completed',
    policy,
    reason,
  };
}

function parseRuntimeSwitchDeferralSupersededEvent(value: unknown): ConnectedServiceRuntimeSwitchDeferralSupersededSessionEvent | null {
  const record = asRecord(value);
  if (!record || record.type !== 'connected_service_account_switch_deferral_superseded') return null;
  const policy = parseDeferralPolicy(record.policy);
  return {
    type: 'connected_service_account_switch_deferral_superseded',
    ...(policy ? { policy } : {}),
  };
}

function parseRuntimeSwitchAttemptEvent(value: unknown): ConnectedServiceRuntimeSwitchAttemptSessionEvent | null {
  const record = asRecord(value);
  if (!record || record.type !== 'connected_service_account_switch_attempt') return null;
  if (typeof record.ok !== 'boolean') return null;
  const action = record.action === 'restart_requested'
    || record.action === 'hot_applied'
    || record.action === 'metadata_updated'
      ? record.action
      : null;
  if (!action) return null;
  const errorCode = typeof record.errorCode === 'string' && record.errorCode.trim()
    ? record.errorCode.trim()
    : null;
  const attemptedContinuityMode = ConnectedServiceSwitchAttemptedContinuityModeV1Schema.safeParse(record.attemptedContinuityMode);
  const outcome = ConnectedServiceSwitchAttemptOutcomeV1Schema.safeParse(record.outcome);
  const outcomeAction = ConnectedServiceSwitchAttemptOutcomeActionV1Schema.safeParse(record.outcomeAction);
  const groupGeneration = parseNonNegativeInteger(record.groupGeneration);
  const sessionAdoption = ConnectedServiceSwitchAttemptSessionAdoptionV1Schema.safeParse(record.sessionAdoption);
  const sessionAdoptedGeneration = parseNonNegativeInteger(record.sessionAdoptedGeneration);
  const partialState = record.partialState === 'metadata_may_reference_new_binding'
    || record.partialState === 'runtime_auth_applied'
    || record.partialState === 'runtime_auth_partially_applied'
      ? record.partialState
      : null;
  const rawReason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const reason = rawReason ? mapSwitchReason(rawReason) : null;
  const verificationByServiceId = parseSwitchAttemptVerificationByServiceId(record.verificationByServiceId);
  return {
    type: 'connected_service_account_switch_attempt',
    ok: record.ok,
    action,
    ...(rawReason ? { rawReason } : {}),
    ...(reason ? { reason } : {}),
    ...(attemptedContinuityMode.success ? { attemptedContinuityMode: attemptedContinuityMode.data } : {}),
    ...(outcome.success ? { outcome: outcome.data } : {}),
    ...(outcomeAction.success ? { outcomeAction: outcomeAction.data } : {}),
    errorCode,
    ...(ConnectedServiceUxDiagnosticV1Schema.safeParse(record.diagnostic).success
      ? { diagnostic: ConnectedServiceUxDiagnosticV1Schema.parse(record.diagnostic) }
      : {}),
    ...(groupGeneration === undefined ? {} : { groupGeneration }),
    ...(sessionAdoption.success ? { sessionAdoption: sessionAdoption.data } : {}),
    ...(sessionAdoptedGeneration === undefined ? {} : { sessionAdoptedGeneration }),
    partialState,
    ...(verificationByServiceId ? { verificationByServiceId } : {}),
  };
}

function parseSwitchAttemptVerificationByServiceId(value: unknown): ConnectedServiceRuntimeSwitchAttemptSessionEvent['verificationByServiceId'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const parsed: Record<string, {
    status: 'verified' | 'weakly_verified';
    providerAccountId?: string | null;
    activeAccountId?: string | null;
    sharedAuthSurfaceId?: string | null;
    proofStrength?: 'exact' | 'weak' | 'diagnostic';
    source?: string;
    reason?: string;
  }> = {};
  for (const [serviceId, rawVerification] of Object.entries(record)) {
    const trimmedServiceId = serviceId.trim();
    if (!trimmedServiceId) continue;
    const verification = asRecord(rawVerification);
    const status = verification?.status === 'verified' || verification?.status === 'weakly_verified'
      ? verification.status
      : null;
    if (!status) continue;
    const reason = typeof verification?.reason === 'string' && verification.reason.trim().length > 0
      ? verification.reason.trim()
      : undefined;
    const providerAccountId = typeof verification?.providerAccountId === 'string' && verification.providerAccountId.trim().length > 0
      ? verification.providerAccountId.trim()
      : verification?.providerAccountId === null
        ? null
        : undefined;
    const activeAccountId = typeof verification?.activeAccountId === 'string' && verification.activeAccountId.trim().length > 0
      ? verification.activeAccountId.trim()
      : verification?.activeAccountId === null
        ? null
        : undefined;
    const sharedAuthSurfaceId = typeof verification?.sharedAuthSurfaceId === 'string' && verification.sharedAuthSurfaceId.trim().length > 0
      ? verification.sharedAuthSurfaceId.trim()
      : verification?.sharedAuthSurfaceId === null
        ? null
        : undefined;
    const proofStrength = verification?.proofStrength === 'exact'
      || verification?.proofStrength === 'weak'
      || verification?.proofStrength === 'diagnostic'
      ? verification.proofStrength
      : undefined;
    const source = typeof verification?.source === 'string' && verification.source.trim().length > 0
      ? verification.source.trim()
      : undefined;
    const preserveExactProofDetails = status === 'verified'
      && proofStrength === 'exact'
      && (
        typeof providerAccountId === 'string'
        || typeof activeAccountId === 'string'
        || typeof sharedAuthSurfaceId === 'string'
      );
    parsed[trimmedServiceId] = {
      status,
      ...(preserveExactProofDetails && providerAccountId !== undefined ? { providerAccountId } : {}),
      ...(preserveExactProofDetails && activeAccountId !== undefined ? { activeAccountId } : {}),
      ...(preserveExactProofDetails && sharedAuthSurfaceId !== undefined ? { sharedAuthSurfaceId } : {}),
      ...(preserveExactProofDetails ? { proofStrength } : {}),
      ...(preserveExactProofDetails && source ? { source } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRuntimeStateSharingDegradedEvent(value: unknown): ConnectedServiceRuntimeStateSharingDegradedSessionEvent | null {
  const record = asRecord(value);
  if (!record || record.type !== 'provider_state_sharing_degraded') return null;
  const serviceId = typeof record.serviceId === 'string' ? record.serviceId.trim() : '';
  const requestedStateMode = typeof record.requestedStateMode === 'string' ? record.requestedStateMode.trim() : '';
  const effectiveStateMode = typeof record.effectiveStateMode === 'string' ? record.effectiveStateMode.trim() : '';
  const code = typeof record.code === 'string' ? record.code.trim() : '';
  if (!serviceId || !requestedStateMode || !effectiveStateMode || !code) return null;
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
  if (!parsedServiceId.success) return null;
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : undefined;
  const entryName = typeof record.entryName === 'string' && record.entryName.trim() ? record.entryName.trim() : undefined;
  return {
    type: 'provider_state_sharing_degraded',
    serviceId: parsedServiceId.data,
    requestedStateMode,
    effectiveStateMode,
    code,
    ...(reason ? { reason } : {}),
    ...(entryName ? { entryName } : {}),
  };
}

function mapSwitchReason(reason: string): TranscriptSwitchReason | null {
  switch (reason) {
    case 'usage_limit':
    case 'rate_limit':
    case 'capacity':
    case 'same_provider_account_exhausted':
      return 'usage_limit';
    case 'soft_threshold':
      return 'soft_threshold';
    case 'auth_expired':
    case 'auth_invalid':
    case 'account_disabled':
    case 'permission_denied':
      return 'auth_expired';
    case 'account_changed':
      return 'account_changed';
    case 'refresh_failed':
    case 'refresh_failure':
      return 'refresh_failure';
    case 'manual':
      return 'manual';
    default:
      return null;
  }
}

function readDisplayLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function buildSwitchDeferralEventId(deferral: ConnectedServiceRuntimeSwitchDeferralSessionEvent): string {
  return buildAgentEventLocalId('connected-service-account-switch-deferral', [
    deferral.policy,
    deferral.awaitingBoundary ? 'awaiting_boundary' : 'awaiting_idle',
    deferral.timeoutMs,
  ]);
}

function buildSwitchDeferralCompletionEventId(
  deferralCompletion: ConnectedServiceRuntimeSwitchDeferralCompletionSessionEvent,
): string {
  return buildAgentEventLocalId('connected-service-account-switch-deferral-completed', [
    deferralCompletion.policy,
    deferralCompletion.reason,
  ]);
}

function buildSwitchDeferralSupersededEventId(
  superseded: ConnectedServiceRuntimeSwitchDeferralSupersededSessionEvent,
): string {
  return buildAgentEventLocalId('connected-service-account-switch-deferral-superseded', [
    superseded.policy ?? 'unknown',
  ]);
}

function buildSwitchAttemptEventId(attempt: ConnectedServiceRuntimeSwitchAttemptSessionEvent): string {
  return buildAgentEventLocalId('connected-service-account-switch-attempt', [
    attempt.ok ? 'ok' : 'failed',
    attempt.action,
    attempt.reason ?? attempt.rawReason ?? 'unknown',
    attempt.attemptedContinuityMode ?? 'unknown',
    attempt.outcome ?? 'unknown',
    attempt.outcomeAction ?? 'unknown',
    attempt.errorCode ?? 'none',
  ]);
}

function buildProviderStateSharingDegradedEventId(
  degraded: ConnectedServiceRuntimeStateSharingDegradedSessionEvent,
): string {
  return buildAgentEventLocalId('provider-state-sharing-degraded', [
    degraded.serviceId,
    degraded.requestedStateMode,
    degraded.effectiveStateMode,
    degraded.code,
    degraded.reason,
  ]);
}

function buildConnectedServiceAccountSwitchEventId(
  parsed: ConnectedServiceRuntimeSwitchSessionEvent,
  reason: TranscriptSwitchReason,
): string {
  const groupPart = parsed.groupId ?? 'direct';
  if (parsed.generation !== undefined) {
    return buildAgentEventLocalId('connected-service-account-switch', [
      parsed.serviceId,
      groupPart,
      parsed.generation,
    ]);
  }
  return buildAgentEventLocalId('connected-service-account-switch', [
    parsed.serviceId,
    groupPart,
    parsed.fromProfileId ?? 'none',
    parsed.toProfileId ?? 'none',
    reason,
    parsed.mode,
  ]);
}

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

function buildAgentEventPayload(params: Readonly<{
  eventId: string;
  data: TranscriptRawAgentEventV1;
}>): Readonly<{
  role: 'agent';
  content: {
    type: 'event';
    id: string;
    data: TranscriptRawAgentEventV1;
  };
}> {
  return {
    role: 'agent',
    content: {
      type: 'event',
      id: params.eventId,
      data: params.data,
    },
  };
}

async function commitAgentEventStoredMessage(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  rawSession: Awaited<ReturnType<typeof fetchSessionById>>;
  eventId: string;
  data: TranscriptRawAgentEventV1;
}>): Promise<void> {
  await commitSessionStoredMessage({
    token: params.credentials.token,
    sessionId: params.sessionId,
    localId: params.eventId,
    messageRole: 'event',
    attentionImpact: agentEventAttentionImpact(params.data, params.eventId),
    content: buildStoredContent({
      credentials: params.credentials,
      rawSession: params.rawSession,
      payload: buildAgentEventPayload({
        eventId: params.eventId,
        data: params.data,
      }),
    }),
  });
}

export async function commitConnectedServiceAccountSwitchSessionEvent(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  event: unknown;
  listConnectedServiceProfiles?: (input: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceNotificationProfileSummary>;
  }>>;
  getConnectedServiceAuthGroup?: (input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<Readonly<{
    groupId: string;
    displayName?: string | null;
  }> | null>;
}>): Promise<void> {
  const deferral = parseRuntimeSwitchDeferralEvent(params.event);
  if (deferral) {
    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
    });
    if (!rawSession) return;
    const eventId = buildSwitchDeferralEventId(deferral);
    await commitAgentEventStoredMessage({
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      eventId,
      data: {
        type: 'connected-service-account-switch-deferral',
        policy: deferral.policy,
        awaitingBoundary: deferral.awaitingBoundary,
        timeoutMs: deferral.timeoutMs,
      },
    });
    return;
  }

  const deferralCompletion = parseRuntimeSwitchDeferralCompletionEvent(params.event);
  if (deferralCompletion) {
    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
    });
    if (!rawSession) return;
    const eventId = buildSwitchDeferralCompletionEventId(deferralCompletion);
    await commitAgentEventStoredMessage({
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      eventId,
      data: {
        type: 'connected-service-account-switch-deferral-completed',
        policy: deferralCompletion.policy,
        reason: deferralCompletion.reason,
      },
    });
    return;
  }

  const superseded = parseRuntimeSwitchDeferralSupersededEvent(params.event);
  if (superseded) {
    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
    });
    if (!rawSession) return;
    const eventId = buildSwitchDeferralSupersededEventId(superseded);
    await commitAgentEventStoredMessage({
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      eventId,
      data: {
        type: 'connected-service-account-switch-deferral-superseded',
        ...(superseded.policy ? { policy: superseded.policy } : {}),
      },
    });
    return;
  }

  const attempt = parseRuntimeSwitchAttemptEvent(params.event);
  if (attempt) {
    if (isBackgroundConnectedServiceSwitchReason(attempt.rawReason ?? attempt.reason)) return;
    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
    });
    if (!rawSession) return;
    const eventId = buildSwitchAttemptEventId(attempt);
    await commitAgentEventStoredMessage({
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      eventId,
      data: {
        type: 'connected-service-account-switch-attempt',
        ok: attempt.ok,
        action: attempt.action,
        ...(attempt.reason ? { reason: attempt.reason } : {}),
        ...(attempt.attemptedContinuityMode ? { attemptedContinuityMode: attempt.attemptedContinuityMode } : {}),
        ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
        ...(attempt.outcomeAction ? { outcomeAction: attempt.outcomeAction } : {}),
        ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
        ...(attempt.diagnostic ? { diagnostic: attempt.diagnostic } : {}),
        ...(attempt.groupGeneration === undefined ? {} : { groupGeneration: attempt.groupGeneration }),
        ...(attempt.sessionAdoption ? { sessionAdoption: attempt.sessionAdoption } : {}),
        ...(attempt.sessionAdoptedGeneration === undefined
          ? {}
          : { sessionAdoptedGeneration: attempt.sessionAdoptedGeneration }),
        ...(attempt.partialState ? { partialState: attempt.partialState } : {}),
        ...(attempt.verificationByServiceId
          ? { verificationByServiceId: attempt.verificationByServiceId }
          : {}),
      },
    });
    return;
  }

  const degraded = parseRuntimeStateSharingDegradedEvent(params.event);
  if (degraded) {
    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
    });
    if (!rawSession) return;
    const eventId = buildProviderStateSharingDegradedEventId(degraded);
    await commitAgentEventStoredMessage({
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      eventId,
      data: {
        type: 'provider-state-sharing-degraded',
        serviceId: degraded.serviceId,
        requestedStateMode: degraded.requestedStateMode,
        effectiveStateMode: degraded.effectiveStateMode,
        code: degraded.code,
        ...(degraded.reason ? { reason: degraded.reason } : {}),
      },
    });
    return;
  }

  const parsed = parseRuntimeSwitchEvent(params.event);
  if (parsed && isBackgroundConnectedServiceSwitchReason(parsed.reason)) return;
  const reason = parsed ? mapSwitchReason(parsed.reason) : null;
  if (!parsed || !reason) return;
  if (isSameProfileRuntimeSwitchEvent(parsed)) return;

  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) return;

  const eventId = buildConnectedServiceAccountSwitchEventId(parsed, reason);
  const profilesById = params.listConnectedServiceProfiles
    ? await loadConnectedServiceNotificationProfilesById({
      serviceId: parsed.serviceId,
      listConnectedServiceProfiles: params.listConnectedServiceProfiles,
    })
    : new Map<string, ConnectedServiceNotificationProfileSummary>();
  const fromProfileLabel = resolveConnectedServiceNotificationProfileLabel(profilesById, parsed.fromProfileId);
  const toProfileLabel = resolveConnectedServiceNotificationProfileLabel(profilesById, parsed.toProfileId);
  const groupLabel = readDisplayLabel(parsed.groupLabel)
    ?? (parsed.groupId && params.getConnectedServiceAuthGroup
      ? readDisplayLabel((await params.getConnectedServiceAuthGroup({
        serviceId: parsed.serviceId,
        groupId: parsed.groupId,
      }).catch(() => null))?.displayName)
      : null)
    ?? readDisplayLabel(parsed.groupId);
  await commitAgentEventStoredMessage({
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    eventId,
    data: {
      type: 'connected-service-account-switch',
      serviceId: parsed.serviceId,
      groupId: parsed.groupId,
      ...(groupLabel ? { groupLabel } : {}),
      fromProfileId: parsed.fromProfileId,
      toProfileId: parsed.toProfileId,
      ...(fromProfileLabel ? { fromProfileLabel } : {}),
      ...(toProfileLabel ? { toProfileLabel } : {}),
      reason,
      mode: parsed.mode,
    },
  });
}
