import { z } from 'zod';

import {
  ExecutionRunPublicStateSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../../execution/runs/index.js';
import { ExecutionRunTerminalStatusSchema } from '../../execution/runs/waitForTerminal.js';
import { TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionOrganizationPlacementV1Schema } from '../creation/sessionSpawnNewResultV1.js';
import { ExternalSessionStorageStateV1Schema } from '../external/operationV1.js';
import { SubAgentRunResultV2Schema } from '../../tools/v2/index.js';
import { StopSessionIncompleteReasonSchema } from '../../sessionStop.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { ActionDefinitionIdV1Schema, ActionDefinitionSummaryV1Schema } from '../../actions/actionDefinitionV1.js';
import {
  PrimaryTurnStatusV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
  SessionRuntimeUsageLimitDetailsV1Schema,
  SessionRuntimeIssueV1Schema,
} from './runtimeIssueV1.js';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryAuthSelectionV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SessionUsageLimitRecoveryStatusV1Schema,
  SessionUsageLimitRecoveryV1Schema,
} from '../state/valueSchemas/usageLimitRecovery.js';
import {
  CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY,
  createConnectedServiceMaterializationIdentityV1Schema,
} from '../metadata/connectedServiceMaterializationIdentityV1.js';
import {
  SESSION_PENDING_QUEUE_HOLD_METADATA_KEY,
  SessionPendingQueueHoldV1Schema,
} from '../metadata/sessionPendingQueueHoldV1.js';
import {
  PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY,
  ProviderAccountUsageRefsV1Schema,
} from '../metadata/providerAccountUsageRefsV1.js';
import {
  SESSION_WORKSPACE_LOCATION_METADATA_KEY,
  createSessionWorkspaceLocationV1Schema,
} from '../metadata/sessionWorkspaceLocationV1.js';
import {
  SessionMetadataRecipientProjectionV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema,
  type SessionOwnerMetadataEnvelopeV1,
} from '../metadata/sessionMetadataEnvelopesV1.js';
import {
  SESSION_RUNNER_RUNTIME_METADATA_KEY,
  SessionRunnerRuntimeStateV1Schema,
} from './sessionRunnerRuntimeV1.js';
import {
  parseSessionRuntimeActivityProjectionFields,
  SessionRuntimeActivityStateSchema,
} from '../runtime/activity/index.js';
export {
  ExactSessionTurnEndMutationV1Schema,
  ExactSessionTurnMutationPositiveReceiptV1Schema,
  SessionTurnLifecycleStatusV1Schema,
  SessionTurnMutationActionV1Schema,
  SessionTurnMutationV1Schema,
  SessionTurnProviderCheckpointV1Schema,
  SessionTurnRollbackStateV1Schema,
  SessionTurnTranscriptAnchorsV1Schema,
  isExactSessionTurnEndMutationV1,
  isExactSessionTurnMutationPositiveReceiptV1,
  type ExactSessionTurnEndMutationV1,
  type ExactSessionTurnMutationPositiveReceiptV1,
  type SessionTurnLifecycleStatusV1,
  type SessionTurnMutationActionV1,
  type SessionTurnMutationV1,
  type SessionTurnProviderCheckpointV1,
  type SessionTurnRollbackStateV1,
  type SessionTurnTranscriptAnchorsV1,
} from '../turns/sessionTurnMutationV1.js';
export {
  SessionTurnRollbackV1Schema,
  SessionTurnV1Schema,
  SessionTurnsProjectionV1Schema,
  type SessionTurnRollbackV1,
  type SessionTurnV1,
  type SessionTurnsProjectionV1,
} from '../turns/sessionTurnV1.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
export {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryAuthSelectionV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SessionUsageLimitRecoveryStatusV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryAuthSelectionV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryStatusV1,
  type SessionUsageLimitRecoveryV1,
} from '../state/valueSchemas/usageLimitRecovery.js';
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
export {
  SESSION_PENDING_QUEUE_HOLD_METADATA_KEY,
  SessionPendingQueueHoldEntryV1Schema,
  SessionPendingQueueHoldV1Schema,
  isSessionPendingQueueHoldBlockingPendingDrain,
  readSessionPendingQueueHoldV1FromMetadata,
  removeSessionPendingQueueHoldV1FromMetadata,
  writeSessionPendingQueueHoldV1ToMetadata,
  type SessionPendingQueueHoldEntryV1,
  type SessionPendingQueueHoldV1,
  type WriteSessionPendingQueueHoldV1Input,
} from '../metadata/sessionPendingQueueHoldV1.js';
export {
  PrimaryTurnStatusV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
  SessionRuntimeIssueSourceV1Schema,
  SessionRuntimeUsageLimitDetailsV1Schema,
  SessionRuntimeIssueV1Schema,
  TurnTerminalStatusV1Schema,
  type PrimaryTurnStatusV1,
  type SessionRuntimeTemporaryThrottleDetailsV1,
  type SessionRuntimeUsageLimitDetailsV1,
  type SessionRuntimeIssueSourceV1,
  type SessionRuntimeIssueV1,
  type TurnTerminalStatusV1,
} from './runtimeIssueV1.js';

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
  'subagent_write_forbidden',
  'subagent_not_found',
  'subagent_parent_session_required',
  'subagent_capacity_exceeded',
  'subagent_watch_capacity_exceeded',
  'subagent_session_scope_forbidden',
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
  // Reports the caller's available E2EE material without conflating it with the
  // persisted Session mode. Token-only callers use null, including when listing a
  // retained E2EE Session whose private metadata remains locked.
  encryption: z.object({
    type: z.enum(['legacy', 'dataKey']),
  }).passthrough().nullable(),
  latestTurnId: TurnIdSchema.nullable().optional(),
  latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
  latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
  lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
  runtimeActivityState: SessionRuntimeActivityStateSchema.optional(),
  runtimeActivityActiveCount: z.number().int().nonnegative().optional(),
  runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
  runtimeActivityRevision: z.number().int().nonnegative().optional(),
  rollbackEligibleTurnStarts: z.array(z.number().int().nonnegative()).optional(),
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

export const VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG =
  'system:voice-transcript-history:v1';
export const VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY =
  'voice_transcript_history';

export function createSessionMetadataSchema(zod: typeof z) {
  return zod
    .object({
      systemSessionV1: createSessionSystemSessionV1Schema(zod).optional(),
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: SessionUsageLimitRecoveryV1Schema.optional(),
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: SessionRunnerRuntimeStateV1Schema.optional(),
      [SESSION_PENDING_QUEUE_HOLD_METADATA_KEY]: SessionPendingQueueHoldV1Schema.optional(),
      [PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY]: ProviderAccountUsageRefsV1Schema.optional(),
      [CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY]:
        createConnectedServiceMaterializationIdentityV1Schema(zod).optional(),
      [SESSION_WORKSPACE_LOCATION_METADATA_KEY]:
        createSessionWorkspaceLocationV1Schema(zod).optional(),
    })
    .passthrough();
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

function refineV2SessionMetadataRecipientFields(
  value: Readonly<{
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion?: number;
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1 | null;
    agentState?: string | null;
    agentStateVersion?: number;
    share?: SessionShare | null;
  }>,
  context: z.RefinementCtx,
): void {
  const metadataLayoutVersion = value.metadataLayoutVersion ?? 0;
  if (metadataLayoutVersion !== 0 && metadataLayoutVersion !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['metadataLayoutVersion'],
      message: 'Unsupported Session metadata layout',
    });
    return;
  }

  const hasAgentState = Object.hasOwn(value, 'agentState');
  const hasAgentStateVersion = Object.hasOwn(value, 'agentStateVersion');
  if (metadataLayoutVersion === 0) {
    if (Object.hasOwn(value, 'ownerMetadata')) {
      context.addIssue({
        code: 'custom',
        path: ['ownerMetadata'],
        message: 'Layout-zero compatibility records cannot carry owner metadata',
      });
    }
    if (!hasAgentState) {
      context.addIssue({
        code: 'custom',
        path: ['agentState'],
        message: 'Layout-zero compatibility records require Agent state',
      });
    }
    if (!hasAgentStateVersion) {
      context.addIssue({
        code: 'custom',
        path: ['agentStateVersion'],
        message: 'Layout-zero compatibility records require an Agent-state version',
      });
    }
    return;
  }

  const hasOwnerMetadata = Object.hasOwn(value, 'ownerMetadata');
  if (value.share === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['share'],
      message: 'Layout-one records require an explicit recipient share role',
    });
  }
  if (value.share !== undefined && value.share !== null && hasOwnerMetadata) {
    context.addIssue({
      code: 'custom',
      path: ['ownerMetadata'],
      message: 'Shared-recipient records cannot carry owner metadata',
    });
  }
  if (value.share === null && !hasOwnerMetadata) {
    context.addIssue({
      code: 'custom',
      path: ['ownerMetadata'],
      message: 'Owner-recipient records require owner metadata',
    });
  }

  const projection = {
    metadata: value.metadata,
    metadataVersion: value.metadataVersion,
    metadataLayoutVersion,
    ...(value.ownerMetadata !== undefined
      ? { ownerMetadata: value.ownerMetadata }
      : {}),
    ...(hasAgentState ? { agentState: value.agentState } : {}),
    ...(hasAgentStateVersion
      ? { agentStateVersion: value.agentStateVersion }
      : {}),
  };
  const parsed = SessionMetadataRecipientProjectionV1Schema.safeParse(projection);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  }
}

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
    metadataLayoutVersion: z.number().int().nonnegative().optional(),
    ownerMetadata:
      SessionOwnerMetadataEnvelopeV1Schema.nullable().optional(),
    agentState: z.string().nullable().optional(),
    agentStateVersion: z.number().int().nonnegative().optional(),
    lastViewedSessionSeq: z.number().int().nonnegative().nullable().optional(),
    pendingPermissionRequestCount: z.number().int().min(0).optional(),
    pendingUserActionRequestCount: z.number().int().min(0).optional(),
    pendingRequestObservedAt: z.number().int().nonnegative().nullable().optional(),
    pendingCount: z.number().int().min(0).optional(),
    pendingBlockedCount: z.number().int().min(0).optional(),
    pendingVersion: z.number().int().min(0).optional(),
    dataEncryptionKey: z.string().nullable(),
    share: SessionShareSchema.nullable().optional(),
    latestTurnId: TurnIdSchema.nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.optional(),
    runtimeActivityActiveCount: z.number().int().nonnegative().optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityRevision: z.number().int().nonnegative().optional(),
    rollbackEligibleTurnStarts: z.array(z.number().int().nonnegative()).optional(),
    latestReadyEventSeq: z.number().int().nonnegative().nullable().optional(),
    latestReadyEventAt: z.number().int().nonnegative().nullable().optional(),
    thinking: z.boolean().optional(),
    thinkingAt: z.number().int().nonnegative().nullable().optional(),
    currentStorageState: ExternalSessionStorageStateV1Schema.optional(),
    acceptedThroughServerSeq: z.number().int().nonnegative().nullable().optional(),
    materializedThroughSourceAt: z.number().int().nonnegative().nullable().optional(),
    publishedThroughServerSeq: z.number().int().nonnegative().nullable().optional(),
    transcriptShareable: z.boolean().optional(),
  })
  .passthrough()
  .superRefine(refineV2SessionMetadataRecipientFields)
  .superRefine(refineRuntimeActivityProjectionFields);
export type V2SessionRecord = z.infer<typeof V2SessionRecordSchema>;

export const SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2 = 4;
export const SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 = 256;

const SessionLookupTagV2Schema = z
  .string()
  .min(1)
  .max(SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2);

export const SessionLookupByTagsRequestV2Schema = z
  .object({
    tags: z
      .array(SessionLookupTagV2Schema)
      .min(1)
      .max(SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2)
      .refine((tags) => new Set(tags).size === tags.length, {
        message: 'Session lookup tags must be unique',
      }),
  })
  .strict();
export type SessionLookupByTagsRequestV2 = z.infer<typeof SessionLookupByTagsRequestV2Schema>;

export const SessionLookupByTagsResponseV2Schema = z
  .object({
    sessions: z.array(V2SessionRecordSchema).max(SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2),
  })
  .strict();
export type SessionLookupByTagsResponseV2 = z.infer<typeof SessionLookupByTagsResponseV2Schema>;

/**
 * The canonical server-owned proof used only to admit one new
 * session-scoped dynamic Resource context. It deliberately carries no Session
 * record, no Resource identity, and no inventory: authorization belongs to
 * the Session-access owner, while Resource lifetime stays local to its owner.
 */
export const V2SessionResourceAccessResponseSchema = z
  .object({
    accountId: z.string().trim().min(1).max(256),
    throughCursor: z.number().int().nonnegative(),
    status: z.enum(['available', 'unavailable']),
  })
  .strict();
export type V2SessionResourceAccessResponse = z.infer<typeof V2SessionResourceAccessResponseSchema>;

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
    attentionNextCursor: z.string().nullable().optional(),
    attentionHasNext: z.boolean().optional(),
  })
  .passthrough();
export type V2SessionListResponse = z.infer<typeof V2SessionListResponseSchema>;

export const V2_SESSION_LIST_CURSOR_V1_PREFIX = 'cursor_v1_' as const;
export const V2_SESSION_LIST_CURSOR_V2_PREFIX = 'cursor_v2_' as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeV2SessionListCursorV1(sessionId: string): string {
  return `${V2_SESSION_LIST_CURSOR_V1_PREFIX}${sessionId}`;
}

export function decodeV2SessionListCursorV1(cursor: string): string | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(V2_SESSION_LIST_CURSOR_V1_PREFIX)) return null;
  const sessionId = cursor.slice(V2_SESSION_LIST_CURSOR_V1_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

export type V2SessionListCursorV2 = Readonly<{
  sessionId: string;
  meaningfulActivityAt: number;
}>;

export function encodeV2SessionListCursorV2(cursor: V2SessionListCursorV2): string {
  const payload = JSON.stringify({
    sessionId: cursor.sessionId,
    meaningfulActivityAt: cursor.meaningfulActivityAt,
  });
  return `${V2_SESSION_LIST_CURSOR_V2_PREFIX}${encodeBase64(textEncoder.encode(payload), 'base64url')}`;
}

export function decodeV2SessionListCursorV2(cursor: string): V2SessionListCursorV2 | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(V2_SESSION_LIST_CURSOR_V2_PREFIX)) return null;
  try {
    const payload = cursor.slice(V2_SESSION_LIST_CURSOR_V2_PREFIX.length);
    const decoded = JSON.parse(textDecoder.decode(decodeBase64(payload, 'base64url')));
    if (!decoded || typeof decoded !== 'object') return null;
    const sessionId = typeof decoded.sessionId === 'string' ? decoded.sessionId : '';
    const meaningfulActivityAt = (decoded as { meaningfulActivityAt?: unknown }).meaningfulActivityAt;
    if (!sessionId || typeof meaningfulActivityAt !== 'number' || !Number.isFinite(meaningfulActivityAt) || meaningfulActivityAt < 0) {
      return null;
    }
    return { sessionId, meaningfulActivityAt: Math.trunc(meaningfulActivityAt) };
  } catch {
    return null;
  }
}

export const V2SessionByIdResponseSchema = z
  .object({
    session: V2SessionRecordSchema,
    created: z.boolean().optional(),
    organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
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
  status: ExecutionRunTerminalStatusSchema,
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

export const SessionControlActionSpecSummarySchema = ActionDefinitionSummaryV1Schema;
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
    actionId: ActionDefinitionIdV1Schema,
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
