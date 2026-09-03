import { z } from 'zod';
import { PendingLocalIdSchema } from '../sessionMessages/pendingLocalId.js';
import { PendingActivationAuthorizationV1Schema } from './pendingActivationAuthorizationV1.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';

import {
  ExecutionRunPublicStateSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../executionRuns.js';
import { ActionIdSchema, ActionInputHintsSchema, ActionSafetySchema, ActionSurfaceSchema } from '../actions/index.js';
import { ActionUiPlacementSchema } from '../actions/actionUiPlacements.js';
import { SubAgentRunResultV2Schema } from '../tools/v2/index.js';
import { StopSessionIncompleteReasonSchema } from '../sessionStop.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import {
  PrimaryTurnStatusV1Schema,
  SessionRuntimeIssueV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
} from '../sessions/control/runtimeIssueV1.js';
import {
  parseSessionRuntimeActivityProjectionFields,
  SessionRuntimeActivityActiveCountSchema,
  SessionRuntimeActivityStateSchema,
} from '../sessionRuntimeActivity/projection.js';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
} from '../sessionMetadata/sessionUsageLimitRecoveryV1.js';
import {
  PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY,
  ProviderAccountUsageRefsV1Schema,
} from '../sessionMetadata/providerAccountUsageRefsV1.js';
import {
  createSessionWorkspaceLocationV1Schema,
  SESSION_WORKSPACE_LOCATION_METADATA_KEY,
} from '../sessionMetadata/sessionWorkspaceLocationV1.js';

const LEGACY_CONNECTED_SERVICE_QUOTA_REFS_METADATA_KEY = 'connectedServiceQuotaRefsV1' as const;
export {
  SessionTurnIdentifierV1Schema,
  SessionTurnLifecycleStatusV1Schema,
  SessionTurnProviderV1Schema,
  SessionTurnRollbackFacetBaseV1Schema,
  SessionTurnRollbackFacetV1Schema,
  SessionTurnRollbackStateV1Schema,
  SessionTurnSeqV1Schema,
  SessionTurnTimestampV1Schema,
  SessionTurnTranscriptAnchorsV1Schema,
  SessionTurnV1Schema,
  buildSessionTurnV1,
  countCompletedSessionTurnsFromStartSeq,
  findCompletedSessionTurnByStartUserSeq,
  listCompletedSessionTurns,
  resolveLatestCompletedSessionTurn,
  type SessionTurnLifecycleStatusV1,
  type SessionTurnRollbackFacetV1,
  type SessionTurnRollbackStateV1,
  type SessionTurnTranscriptAnchorsV1,
  type SessionTurnV1,
} from '../sessions/turns/sessionTurnV1.js';
export {
  ExactSessionTurnEndMutationV1Schema,
  ExactSessionTurnMutationPositiveReceiptV1Schema,
  isExactSessionTurnEndMutationV1,
  isExactSessionTurnMutationPositiveReceiptV1,
  SessionTurnMutationActionV1Schema,
  SessionTurnMutationDecisionV1Schema,
  SessionTurnMutationReceiptV1Schema,
  SessionTurnMutationV1Schema,
  type ExactSessionTurnEndMutationV1,
  type ExactSessionTurnMutationPositiveReceiptV1,
  type SessionTurnMutationActionV1,
  type SessionTurnMutationDecisionV1,
  type SessionTurnMutationReceiptV1,
  type SessionTurnMutationV1,
} from '../sessions/turns/sessionTurnMutationV1.js';
export {
  SessionTurnsProjectionV1Schema,
  buildSessionTurnsProjectionV1,
  type SessionTurnsProjectionV1,
} from '../sessions/turns/sessionTurnsProjectionV1.js';
export {
  PrimaryTurnStatusV1Schema,
  SessionRuntimeIssueSourceV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
  SessionRuntimeUsageLimitDetailsV1Schema,
  SessionRuntimeIssueV1Schema,
  TurnTerminalStatusV1Schema,
  type PrimaryTurnStatusV1,
  type SessionRuntimeIssueSourceV1,
  type SessionRuntimeTemporaryThrottleDetailsV1,
  type SessionRuntimeUsageLimitDetailsV1,
  type SessionRuntimeIssueV1,
  type TurnTerminalStatusV1,
} from '../sessions/control/runtimeIssueV1.js';
export {
  SessionContinuationRecoveryIdentityV1Schema,
  SessionContinuationRecoverySelectionKindV1Schema,
  SessionContinuationResumePromptModeV1Schema,
  type SessionContinuationRecoveryIdentityV1,
  type SessionContinuationRecoverySelectionKindV1,
  type SessionContinuationResumePromptModeV1,
} from '../sessionMetadata/sessionContinuationRecoveryIdentityV1.js';
export {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryAuthSelectionV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  resolveSessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryAuthSelectionV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
} from '../sessionMetadata/sessionUsageLimitRecoveryV1.js';
export {
  SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_ERROR_STATUSES_V1,
  SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_OK_STATUSES_V1,
  SessionUsageLimitRecoveryOperationResultErrorStatusV1Schema,
  SessionUsageLimitRecoveryOperationResultOkStatusV1Schema,
  SessionUsageLimitRecoveryOperationResultV1Schema,
  isSessionUsageLimitRecoveryOperationResultV1,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
  type SessionUsageLimitRecoveryOperationResultErrorStatusV1,
  type SessionUsageLimitRecoveryOperationResultOkStatusV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from './sessionUsageLimitRecoveryOperationResultV1.js';

export const SessionControlErrorCodeSchema = z.enum([
  'not_authenticated',
  'server_unreachable',
  'session_not_found',
  'session_id_ambiguous',
  'session_active',
  'execution_run_not_found',
  'execution_run_action_not_supported',
  'execution_run_invalid_action_input',
  'execution_run_stream_not_found',
  'execution_run_not_allowed',
  'execution_run_protocol_unsupported',
  'execution_run_target_unavailable',
  'run_depth_exceeded',
  'conflict',
  'timeout',
  'invalid_arguments',
  'unsupported',
  'unknown_error',
  'already_exists',
]);
export type SessionControlErrorCode = z.infer<typeof SessionControlErrorCodeSchema>;

export const SessionControlErrorSchema = z.object({
  code: SessionControlErrorCodeSchema,
  message: z.string().optional(),
  details: z.unknown().optional(),
}).passthrough();
export type SessionControlError = z.infer<typeof SessionControlErrorSchema>;

export const SessionControlEnvelopeSuccessSchema = z.object({
  v: z.literal(1),
  ok: z.literal(true),
  kind: z.string().min(1),
  data: z.unknown(),
}).passthrough();
export type SessionControlEnvelopeSuccess = z.infer<typeof SessionControlEnvelopeSuccessSchema>;

export const SessionControlEnvelopeErrorSchema = z.object({
  v: z.literal(1),
  ok: z.literal(false),
  kind: z.string().min(1),
  error: SessionControlErrorSchema,
}).passthrough();
export type SessionControlEnvelopeError = z.infer<typeof SessionControlEnvelopeErrorSchema>;

export const SessionControlEnvelopeBaseSchema = z.discriminatedUnion('ok', [
  SessionControlEnvelopeSuccessSchema,
  SessionControlEnvelopeErrorSchema,
]);
export type SessionControlEnvelopeBase = z.infer<typeof SessionControlEnvelopeBaseSchema>;

export const AuthStatusResultSchema = z.object({
  authenticated: z.literal(true),
  encryption: z.object({
    type: z.enum(['legacy', 'dataKey']),
  }).passthrough(),
  machineRegistered: z.boolean(),
  machineId: z.string().min(1).optional(),
  host: z.string().min(1),
  happyHomeDir: z.string().min(1),
  daemonRunning: z.boolean(),
}).passthrough();
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  active: z.boolean(),
  activeAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  pendingBlockedCount: z.number().int().nonnegative().optional(),
  tag: z.string().optional(),
  title: z.string().min(1).optional(),
  path: z.string().optional(),
  host: z.string().optional(),
  share: z.object({
    accessLevel: z.string().min(1),
    canApprovePermissions: z.boolean(),
  }).nullable().optional(),
  isSystem: z.boolean().optional(),
  systemPurpose: z.string().nullable().optional(),
  encryptionMode: AccountEncryptionModeSchema.optional(),
  encryption: z.object({
    type: z.enum(['legacy', 'dataKey']),
  }).passthrough(),
  latestTurnId: z.string().min(1).nullable().optional(),
  latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
  lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
  runtimeActivityState: SessionRuntimeActivityStateSchema.nullable().optional(),
  runtimeActivityActiveCount: SessionRuntimeActivityActiveCountSchema.optional(),
  runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
  runtimeActivityRevision: z.number().int().nonnegative().safe().optional(),
  pendingActivationAuthorization: PendingActivationAuthorizationV1Schema.optional(),
}).passthrough().superRefine(refineRuntimeActivityProjectionFields);
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * Factory form (accepts a caller-provided `z`) for nohoist/multi-zod-instance repos.
 * Consumers that need to embed the schema into their own Zod objects should use this
 * instead of importing `SessionSystemSessionV1Schema` directly.
 */
export function createSessionSystemSessionV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    key: zod.string(),
    hidden: zod.boolean().optional(),
  }).passthrough();
}

export const SessionSystemSessionV1Schema = createSessionSystemSessionV1Schema(z);
export type SessionSystemSessionV1 = z.infer<typeof SessionSystemSessionV1Schema>;

export function createSessionMetadataSchema(zod: typeof z) {
  return zod
    .object({
      systemSessionV1: createSessionSystemSessionV1Schema(zod).optional(),
      [SESSION_WORKSPACE_LOCATION_METADATA_KEY]: createSessionWorkspaceLocationV1Schema(zod).optional(),
      // Remote-dev does not yet have the registered session-state field catalog used by dev.
      // This metadata key is the compatible storage binding for runtime.usageLimitRecovery.
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: SessionUsageLimitRecoveryV1Schema.optional(),
      [PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY]: ProviderAccountUsageRefsV1Schema.optional(),
    })
    .passthrough()
    .transform((metadata) => {
      const {
        [LEGACY_CONNECTED_SERVICE_QUOTA_REFS_METADATA_KEY]: _legacyConnectedServiceQuotaRefs,
        ...nextMetadata
      } = metadata;
      return nextMetadata;
    });
}

export const SessionMetadataSchema = createSessionMetadataSchema(z);
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export function readSystemSessionMetadataFromMetadata(params: Readonly<{ metadata: unknown }>): SessionSystemSessionV1 | null {
  // Hot path: this runs inside per-session loops on store notifications (session list
  // filtering, voice lookups, CLI row building). Parse only the marker field itself —
  // validating the whole metadata blob here is both wasteful and wrong (a malformed
  // sibling field must not hide a system session).
  const metadata = params.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const marker = (metadata as Record<string, unknown>).systemSessionV1;
  if (typeof marker !== 'object' || marker === null) return null;
  const parsed = SessionSystemSessionV1Schema.safeParse(marker);
  return parsed.success ? parsed.data : null;
}

export function isHiddenSystemSession(params: Readonly<{ metadata: unknown }>): boolean {
  const systemSession = readSystemSessionMetadataFromMetadata(params);
  return Boolean(systemSession && systemSession.hidden === true);
}

export function buildSystemSessionMetadataV1(params: Readonly<{ key: string; hidden?: boolean }>): { systemSessionV1: SessionSystemSessionV1 } {
  const hidden = params.hidden;
  return {
    systemSessionV1: {
      v: 1,
      key: params.key,
      ...(typeof hidden === 'boolean' ? { hidden } : {}),
    },
  };
}

export const SessionListResultSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.string().nullable().optional(),
  hasNext: z.boolean().optional(),
}).passthrough();
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

export const SessionShareSchema = z
  .object({
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.boolean(),
  })
  .passthrough();
export type SessionShare = z.infer<typeof SessionShareSchema>;

export const V2SessionRecordSchema = z
  .object({
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    meaningfulActivityAt: z.number().int().nonnegative().optional(),
    active: z.boolean(),
    activeAt: z.number().int().nonnegative(),
    archivedAt: z.number().int().nonnegative().nullable().optional(),
    encryptionMode: AccountEncryptionModeSchema.optional(),
    metadata: z.string(),
    metadataVersion: z.number().int().nonnegative(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number().int().nonnegative(),
    lastViewedSessionSeq: z.number().int().nonnegative().nullable().optional(),
    // Server-materialized instant the session entered the unread state (cleared on read).
    // Declared rather than left to passthrough so it is typed for readers and so the
    // consumers that derive their coverage from this shape can catch it being dropped.
    unreadSince: z.number().int().nonnegative().nullable().optional(),
    pendingPermissionRequestCount: z.number().int().min(0).optional(),
    pendingUserActionRequestCount: z.number().int().min(0).optional(),
    pendingRequestObservedAt: z.number().int().nonnegative().nullable().optional(),
    latestReadyEventSeq: z.number().int().nonnegative().nullable().optional(),
    latestReadyEventAt: z.number().int().nonnegative().nullable().optional(),
    thinking: z.boolean().optional(),
    thinkingAt: z.number().int().nonnegative().nullable().optional(),
    pendingCount: z.number().int().min(0).optional(),
    pendingBlockedCount: z.number().int().min(0).optional(),
    pendingVersion: z.number().int().min(0).optional(),
    dataEncryptionKey: z.string().nullable(),
    share: SessionShareSchema.nullable().optional(),
    latestTurnId: z.string().min(1).nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.nullable().optional(),
    runtimeActivityActiveCount: SessionRuntimeActivityActiveCountSchema.optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityRevision: z.number().int().nonnegative().safe().optional(),
    pendingActivationAuthorization: PendingActivationAuthorizationV1Schema.optional(),
  })
  .passthrough()
  .superRefine(refineRuntimeActivityProjectionFields);
export type V2SessionRecord = z.infer<typeof V2SessionRecordSchema>;

function refineRuntimeActivityProjectionFields(
  value: unknown,
  context: z.RefinementCtx,
): void {
  if (parseSessionRuntimeActivityProjectionFields(value).kind !== 'invalid') return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Runtime Activity projection fields must form one complete valid tuple',
    path: ['runtimeActivityState'],
  });
}

export const V2SessionListResponseSchema = z
  .object({
    sessions: z.array(V2SessionRecordSchema),
    nextCursor: z.string().nullable().optional(),
    hasNext: z.boolean().optional(),
  })
  .passthrough();
export type V2SessionListResponse = z.infer<typeof V2SessionListResponseSchema>;

export const V2_SESSION_LIST_CURSOR_V1_PREFIX = 'cursor_v1_' as const;
export const V2_SESSION_LIST_CURSOR_V2_PREFIX = 'cursor_v2_' as const;

export type V2SessionListCursorV2 = Readonly<{
  sessionId: string;
  meaningfulActivityAt: number;
}>;

export function encodeV2SessionListCursorV1(sessionId: string): string {
  return `${V2_SESSION_LIST_CURSOR_V1_PREFIX}${sessionId}`;
}

export function decodeV2SessionListCursorV1(cursor: string): string | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(V2_SESSION_LIST_CURSOR_V1_PREFIX)) return null;
  const sessionId = cursor.slice(V2_SESSION_LIST_CURSOR_V1_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

export function encodeV2SessionListCursorV2(cursor: V2SessionListCursorV2): string {
  const sessionId = String(cursor.sessionId ?? '').trim();
  const meaningfulActivityAt = Number.isFinite(cursor.meaningfulActivityAt)
    ? Math.max(0, Math.trunc(cursor.meaningfulActivityAt))
    : 0;
  const json = JSON.stringify({ sessionId, meaningfulActivityAt });
  const payload = encodeBase64(new TextEncoder().encode(json), 'base64url');
  return `${V2_SESSION_LIST_CURSOR_V2_PREFIX}${payload}`;
}

export function decodeV2SessionListCursorV2(cursor: string): V2SessionListCursorV2 | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(V2_SESSION_LIST_CURSOR_V2_PREFIX)) return null;
  const payload = cursor.slice(V2_SESSION_LIST_CURSOR_V2_PREFIX.length);
  if (!payload) return null;
  try {
    const json = new TextDecoder().decode(decodeBase64(payload, 'base64url'));
    const parsed = JSON.parse(json) as Partial<V2SessionListCursorV2>;
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
    const meaningfulActivityAt = typeof parsed.meaningfulActivityAt === 'number' && Number.isFinite(parsed.meaningfulActivityAt)
      ? Math.trunc(parsed.meaningfulActivityAt)
      : -1;
    return sessionId && meaningfulActivityAt >= 0 ? { sessionId, meaningfulActivityAt } : null;
  } catch {
    return null;
  }
}

export const V2SessionByIdResponseSchema = z
  .object({
    session: V2SessionRecordSchema,
  })
  .passthrough();
export type V2SessionByIdResponse = z.infer<typeof V2SessionByIdResponseSchema>;

export const V2SessionByIdNotFoundSchema = z.object({
  error: z.literal('Session not found'),
});
export type V2SessionByIdNotFound = z.infer<typeof V2SessionByIdNotFoundSchema>;

export const V2SessionMessageResponseSchema = z
  .object({
    didWrite: z.boolean(),
    message: z
      .object({
        id: z.string().min(1),
        seq: z.number().int().nonnegative(),
        localId: z.string().nullable(),
        createdAt: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
export type V2SessionMessageResponse = z.infer<typeof V2SessionMessageResponseSchema>;

export const SessionStatusResultSchema = z.object({
  session: SessionSummarySchema,
  agentState: z.object({
    controlledByUser: z.boolean().optional(),
    pendingRequestsCount: z.number().int().nonnegative(),
  }).passthrough().optional(),
}).passthrough();
export type SessionStatusResult = z.infer<typeof SessionStatusResultSchema>;

export const SessionCreateResultSchema = z.object({
  session: SessionSummarySchema,
  created: z.boolean(),
}).passthrough();
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export const SessionSendResultSchema = z.object({
  sessionId: z.string().min(1),
  localId: PendingLocalIdSchema,
  waited: z.boolean(),
}).passthrough();
export type SessionSendResult = z.infer<typeof SessionSendResultSchema>;

export const SessionWaitResultSchema = z.object({
  sessionId: z.string().min(1),
  idle: z.literal(true),
  observedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionWaitResult = z.infer<typeof SessionWaitResultSchema>;

export const SessionStopCleanupIncompleteReasonSchema = StopSessionIncompleteReasonSchema.extract([
  'terminal_control_serviceability_retirement_failed',
  'terminal_attachment_descriptor_retirement_failed',
]);
export type SessionStopCleanupIncompleteReason = z.infer<typeof SessionStopCleanupIncompleteReasonSchema>;

const SessionStopPhysicalUnconfirmedReasonSchema = z.union([
  StopSessionIncompleteReasonSchema.exclude([
    'terminal_control_serviceability_retirement_failed',
    'terminal_attachment_descriptor_retirement_failed',
  ]),
  z.enum([
    'transport_ambiguous',
    'marker_fallback_failed',
    'local_session_not_found',
    'target_daemon_unavailable',
    'target_daemon_forbidden',
    'target_daemon_response_unsupported',
    'target_session_not_found',
    'daemon_stop_requested',
    'unexpected_error',
  ]),
]);

export const SessionStopOutcomeSchema = z.discriminatedUnion('status', [
  /**
   * No runtime existed to stop, and the canonical Session row was observed
   * INACTIVE. This is a confirmed stop, not an unknown one: "nothing is
   * running" is the postcondition a stop exists to establish, and the daemon
   * reporting `not_found` for a Session the server also reports inactive has
   * proved it rather than failed to determine it.
   *
   * It is deliberately its own status rather than a `physical_stop_unconfirmed`
   * reason, because every reason on that arm means "could not determine" and
   * consumers read the STATUS to decide whether liveness is settled.
   */
  z.object({
    status: z.literal('already_stopped'),
    reason: z.literal('no_runtime_session_inactive'),
  }).strict(),
  z.object({
    status: z.literal('stopped_projection_unconfirmed'),
    reason: z.literal('relay_inactive_not_observed'),
  }).strict(),
  z.object({
    status: z.literal('stopped_cleanup_incomplete'),
    reason: SessionStopCleanupIncompleteReasonSchema,
  }).strict(),
  z.object({
    status: z.literal('physical_stop_unconfirmed'),
    reason: SessionStopPhysicalUnconfirmedReasonSchema,
  }).strict(),
]);
export type SessionStopOutcome = z.infer<typeof SessionStopOutcomeSchema>;

const SessionStopResultBaseSchema = z.object({
  sessionId: z.string().min(1),
});

export const SessionStopResultSchema = z.discriminatedUnion('stopped', [
  SessionStopResultBaseSchema.extend({
    stopped: z.literal(true),
  }).passthrough(),
  SessionStopResultBaseSchema.extend({
    stopped: z.literal(false),
    // cli-v0.2.0 and cli-v0.2.1 emitted `{ stopped: false }`; keep reading that
    // released shape while current writers add the structured reason.
    stopOutcome: SessionStopOutcomeSchema.optional(),
  }).passthrough(),
]);
export type SessionStopResult = z.infer<typeof SessionStopResultSchema>;

/**
 * Does this stop result PROVE the Session has no running runtime?
 *
 * One question, one answer, one owner. Two results prove it and they prove it
 * the same way — the canonical Session row was observed inactive: `stopped:
 * true` observed it after signalling a runtime, `already_stopped` observed it
 * after finding none to signal. Every other outcome leaves liveness
 * undetermined, including `stopped_cleanup_incomplete`, which proves the host
 * was destroyed but never reads the row back.
 *
 * Consumers must not re-derive this from statuses or reason strings: the
 * reasons are a lossy diagnostic channel and the same string is emitted at
 * opposite depths.
 */
export function isSessionStopConfirmed(result: SessionStopResult): boolean {
  return result.stopped ? true : result.stopOutcome?.status === 'already_stopped';
}

export const SessionArchiveResultSchema = z.object({
  sessionId: z.string().min(1),
  archivedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionArchiveResult = z.infer<typeof SessionArchiveResultSchema>;

export const SessionUnarchiveResultSchema = z.object({
  sessionId: z.string().min(1),
  archivedAt: z.null(),
}).passthrough();
export type SessionUnarchiveResult = z.infer<typeof SessionUnarchiveResultSchema>;

export const SessionSetTitleResultSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
}).passthrough();
export type SessionSetTitleResult = z.infer<typeof SessionSetTitleResultSchema>;

export const SessionSetPermissionModeResultSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionSetPermissionModeResult = z.infer<typeof SessionSetPermissionModeResultSchema>;

export const SessionSetModelResultSchema = z.object({
  sessionId: z.string().min(1),
  modelId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionSetModelResult = z.infer<typeof SessionSetModelResultSchema>;

export const SessionHistoryCompactMessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  role: z.string().min(1),
  kind: z.string().min(1),
  text: z.string(),
  structuredKind: z.string().min(1).optional(),
}).passthrough();
export type SessionHistoryCompactMessage = z.infer<typeof SessionHistoryCompactMessageSchema>;

export const SessionHistoryRawMessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  role: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
}).passthrough();
export type SessionHistoryRawMessage = z.infer<typeof SessionHistoryRawMessageSchema>;

export const SessionHistoryResultSchema = z.discriminatedUnion('format', [
  z.object({
    sessionId: z.string().min(1),
    format: z.literal('compact'),
    messages: z.array(SessionHistoryCompactMessageSchema),
  }).passthrough(),
  z.object({
    sessionId: z.string().min(1),
    format: z.literal('raw'),
    messages: z.array(SessionHistoryRawMessageSchema),
  }).passthrough(),
]);
export type SessionHistoryResult = z.infer<typeof SessionHistoryResultSchema>;

export const SessionRunStartResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  callId: z.string().min(1),
  intent: z.string().min(1),
  backendId: z.string().min(1),
}).passthrough();
export type SessionRunStartResult = z.infer<typeof SessionRunStartResultSchema>;

export const SessionRunListResultSchema = z.object({
  sessionId: z.string().min(1),
  runs: z.array(ExecutionRunPublicStateSchema),
}).passthrough();
export type SessionRunListResult = z.infer<typeof SessionRunListResultSchema>;

export const SessionRunGetResultSchema = z.object({
  sessionId: z.string().min(1),
  run: ExecutionRunPublicStateSchema,
  latestToolResult: SubAgentRunResultV2Schema.optional(),
  structuredMeta: z.object({ kind: z.string().min(1), payload: z.unknown() }).passthrough().optional(),
}).passthrough();
export type SessionRunGetResult = z.infer<typeof SessionRunGetResultSchema>;

export const SessionRunSendResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  sent: z.literal(true),
}).passthrough();
export type SessionRunSendResult = z.infer<typeof SessionRunSendResultSchema>;

export const SessionRunStopResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  stopped: z.literal(true),
}).passthrough();
export type SessionRunStopResult = z.infer<typeof SessionRunStopResultSchema>;

export const SessionRunActionResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  updatedToolResult: SubAgentRunResultV2Schema.optional(),
}).passthrough();
export type SessionRunActionResult = z.infer<typeof SessionRunActionResultSchema>;

export const SessionRunWaitResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
}).passthrough();
export type SessionRunWaitResult = z.infer<typeof SessionRunWaitResultSchema>;

export const SessionRunStreamStartResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .merge(ExecutionRunTurnStreamStartResponseSchema)
  .passthrough();
export type SessionRunStreamStartResult = z.infer<typeof SessionRunStreamStartResultSchema>;

export const SessionRunStreamReadResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .merge(ExecutionRunTurnStreamReadResponseSchema)
  .passthrough();
export type SessionRunStreamReadResult = z.infer<typeof SessionRunStreamReadResultSchema>;

export const SessionRunStreamCancelResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    streamId: z.string().min(1),
    cancelled: z.literal(true),
  })
  .passthrough();
export type SessionRunStreamCancelResult = z.infer<typeof SessionRunStreamCancelResultSchema>;

export const SessionListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_list'),
  data: SessionListResultSchema,
});

export const SessionHistoryEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_history'),
  data: SessionHistoryResultSchema,
});

export const SessionRunGetEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_get'),
  data: SessionRunGetResultSchema,
});

export const SessionStatusEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_status'),
  data: SessionStatusResultSchema,
});

export const SessionCreateEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_create'),
  data: SessionCreateResultSchema,
});

export const SessionSendEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_send'),
  data: SessionSendResultSchema,
});

export const SessionWaitEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_wait'),
  data: SessionWaitResultSchema,
});

export const SessionStopEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_stop'),
  data: SessionStopResultSchema,
});

export const SessionArchiveEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_archive'),
  data: SessionArchiveResultSchema,
});

export const SessionUnarchiveEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_unarchive'),
  data: SessionUnarchiveResultSchema,
});

export const SessionSetTitleEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_title'),
  data: SessionSetTitleResultSchema,
});

export const SessionSetPermissionModeEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_permission_mode'),
  data: SessionSetPermissionModeResultSchema,
});

export const SessionSetModelEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_model'),
  data: SessionSetModelResultSchema,
});

export const SessionRunStartEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_start'),
  data: SessionRunStartResultSchema,
});

export const SessionRunListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_list'),
  data: SessionRunListResultSchema,
});

export const SessionRunSendEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_send'),
  data: SessionRunSendResultSchema,
});

export const SessionRunStopEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stop'),
  data: SessionRunStopResultSchema,
});

export const SessionRunActionEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_action'),
  data: SessionRunActionResultSchema,
});

export const SessionRunWaitEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_wait'),
  data: SessionRunWaitResultSchema,
});

export const SessionRunStreamStartEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_start'),
  data: SessionRunStreamStartResultSchema,
});

export const SessionRunStreamReadEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_read'),
  data: SessionRunStreamReadResultSchema,
});

export const SessionRunStreamCancelEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_cancel'),
  data: SessionRunStreamCancelResultSchema,
});

export const AuthStatusEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('auth_status'),
  data: AuthStatusResultSchema,
});

export const SessionControlActionSpecSummarySchema = z
  .object({
    id: ActionIdSchema,
    title: z.string().min(1),
    description: z.string().min(1).nullable(),
    safety: ActionSafetySchema,
    placements: z.array(ActionUiPlacementSchema),
    slash: z
      .object({
        tokens: z.array(z.string().min(1)),
      })
      .passthrough()
      .nullable(),
    bindings: z
      .object({
        voiceClientToolName: z.string().min(1).optional(),
        mcpToolName: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable(),
    examples: z
      .object({
        voice: z
          .object({
            argsExample: z.string().min(1).optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        mcp: z
          .object({
            argsExample: z.string().min(1).optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable(),
    surfaces: ActionSurfaceSchema,
    inputHints: ActionInputHintsSchema.nullable(),
  })
  .passthrough();
export type SessionControlActionSpecSummary = z.infer<typeof SessionControlActionSpecSummarySchema>;

export const SessionActionsListResultSchema = z
  .object({
    actionSpecs: z.array(SessionControlActionSpecSummarySchema),
  })
  .passthrough();
export type SessionActionsListResult = z.infer<typeof SessionActionsListResultSchema>;

export const SessionActionsDescribeResultSchema = z
  .object({
    actionSpec: SessionControlActionSpecSummarySchema,
  })
  .passthrough();
export type SessionActionsDescribeResult = z.infer<typeof SessionActionsDescribeResultSchema>;

export const SessionActionsExecuteResultSchema = z
  .object({
    sessionId: z.string().min(1),
    actionId: z.string().min(1),
    result: z.unknown(),
  })
  .passthrough();
export type SessionActionsExecuteResult = z.infer<typeof SessionActionsExecuteResultSchema>;

export const SessionActionsListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_actions_list'),
  data: SessionActionsListResultSchema,
});

export const SessionActionsDescribeEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_actions_describe'),
  data: SessionActionsDescribeResultSchema,
});

export const SessionActionsExecuteEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_actions_execute'),
  data: SessionActionsExecuteResultSchema,
});
