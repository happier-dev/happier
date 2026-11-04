import { createSessionSystemSessionV1Schema } from '../metadata/systemSessionV1.js';
export { createSessionSystemSessionV1Schema, SessionSystemSessionV1Schema, readSystemSessionMetadataFromMetadata, isHiddenSystemSession, buildSystemSessionMetadataV1, type SessionSystemSessionV1 } from '../metadata/systemSessionV1.js';
import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ConnectedServiceBindingsV2Schema } from '../../connect/connectedServiceBindings.js';
import { SessionTeamCredentialBindingIntentV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { z } from 'zod/mini';
import { SessionManagerV1Schema, SessionManagedSessionsV1Schema } from '../follow/sessionManagerV1.js';
import { SessionEffectiveAccessV1Schema, type SessionEffectiveAccessV1 } from '../access/sessionEffectiveAccessV1.js';
import { SessionAccessAccountSummaryV1Schema } from '../access/sessionAccessPrincipalV1.js';
import { SessionSummarySchema, SessionListResultSchema, SessionListMetadataUpgradeRequiredCountSchema } from './listResult.js';
export { SessionSummarySchema, projectSessionSummaryV1, type SessionSummary, SessionListResultSchema, type SessionListResult } from './listResult.js';
import { SessionAwarenessOriginV1Schema, SessionAwarenessProjectionV1Schema } from '../awareness/projectionV1.js';
import { SessionWorkDepthV1Schema } from '../creation/sessionCreateOriginV1.js';
import { SessionViewerProjectionV1Schema } from '../personal/viewer.js';
import { SessionReadinessV1Schema } from './sessionReadinessV1.js';
import { SessionAcceptedWorkspaceV1Schema } from '../../workspaces/workspaceRefV1.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
export { SessionReadinessV1Schema, composeSessionReadinessV1 } from './sessionReadinessV1.js';
export type { SessionReadinessV1, SessionReadinessFactsV1, SessionCredentialReadinessV1, SessionReadinessRepairV1 } from './sessionReadinessV1.js';

import { ExecutionRunPublicStateSchema } from '../../execution/runs/responseSchemas.js';
import {
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../../execution/runs/streaming.js';
import { ExecutionRunTerminalStatusSchema } from '../../execution/runs/waitForTerminal.js';
import { TurnIdSchema } from '../idsV1.js';
import { SessionPermissionRequestIdV1Schema } from '../permissions/v1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionOrganizationPlacementV1Schema } from '../creation/sessionSpawnNewResultV1.js';
import { ExternalSessionStorageStateV1Schema } from '../external/operationV1.js';
import { PendingActivationAuthorizationV1Schema, PendingActivationFailureDetailsV1Schema } from '../pending/pendingActivationAuthorizationV1.js';
import { SubAgentRunResultV2Schema } from '../../tools/v2/schemas.js';
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
import { SESSION_EXPLICIT_STOP_METADATA_KEY, SessionExplicitStopV1Schema } from '../metadata/sessionExplicitStopV1.js';
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
  StoredSessionOwnerMetadataEnvelopeV1Schema,
  type SessionOwnerMetadataEnvelopeV1,
} from '../metadata/sessionMetadataSchemasV1.js';
import { SessionDisplayProjectionV1Schema, type SessionDisplayProjectionV1 } from '../metadata/sessionDisplaySchemasV1.js';
import {
  SESSION_RUNNER_RUNTIME_METADATA_KEY,
  SessionRunnerRuntimeStateV1Schema,
} from './sessionRunnerRuntimeV1.js';
import {
  refineRuntimeActivityProjectionFields,
  SessionRuntimeActivityStateSchema,
} from '../runtime/activity/sessionRuntimeActivity.js';
export {
  ExactSessionTurnEndMutationV1Schema,
  ExactSessionTurnMutationPositiveReceiptV1Schema,
  SessionTurnLifecycleStatusV1Schema,
  SessionTurnInitiatorV1Schema,
  SessionTurnWorkflowInvocationV1Schema,
  SessionTurnFactsV1Schema,
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
  type SessionTurnFactsV1,
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
export {
  V2_SESSION_LIST_CURSOR_V1_PREFIX,
  V2_SESSION_LIST_CURSOR_V2_PREFIX,
  encodeV2SessionListCursorV1,
  decodeV2SessionListCursorV1,
  encodeV2SessionListCursorV2,
  decodeV2SessionListCursorV2,
  type V2SessionListCursorV2,
} from '../listing/cursor.js';
export {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryAuthSelectionV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SessionUsageLimitRecoveryStatusV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  buildUsageLimitIssueFingerprint,
  isSessionUsageLimitRecoveryForIssue,
  readSessionUsageLimitRecoveryForIssue,
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
  SessionRuntimeTeamCredentialDenialDetailsV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
  SessionRuntimeIssueSourceV1Schema,
  SessionRuntimeUsageLimitDetailsV1Schema,
  SessionRuntimeIssueV1Schema,
  TurnTerminalStatusV1Schema,
  type PrimaryTurnStatusV1,
  type SessionRuntimeTeamCredentialDenialDetailsV1,
  type SessionRuntimeTemporaryThrottleDetailsV1,
  type SessionRuntimeUsageLimitDetailsV1,
  type SessionRuntimeIssueSourceV1,
  type SessionRuntimeIssueV1,
  resolveSessionRuntimeIssueSignInRecovery,
  type SessionRuntimeIssueSignInRecovery,
  type TurnTerminalStatusV1,
} from './runtimeIssueV1.js';

export const SessionControlErrorCodeSchema = lazyZodSchema(() => z.enum([
  'not_authenticated',
  'server_unreachable',
  'session_not_found',
  'not_found',
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
]));
export type SessionControlErrorCode = z.infer<typeof SessionControlErrorCodeSchema>;

export const SessionControlErrorSchema = lazyZodSchema(() => z.looseObject({
  code: SessionControlErrorCodeSchema,
  message: z.optional(z.string()),
  details: z.optional(z.unknown()),
}));
export type SessionControlError = z.infer<typeof SessionControlErrorSchema>;

export const SessionControlEnvelopeSuccessSchema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  ok: z.literal(true),
  kind: z.string().check(z.minLength(1)),
  data: z.unknown(),
}));
export type SessionControlEnvelopeSuccess = z.infer<typeof SessionControlEnvelopeSuccessSchema>;

export const SessionControlEnvelopeErrorSchema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  ok: z.literal(false),
  kind: z.string().check(z.minLength(1)),
  error: SessionControlErrorSchema,
}));
export type SessionControlEnvelopeError = z.infer<typeof SessionControlEnvelopeErrorSchema>;

export const SessionControlEnvelopeBaseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  SessionControlEnvelopeSuccessSchema,
  SessionControlEnvelopeErrorSchema,
]));
export type SessionControlEnvelopeBase = z.infer<typeof SessionControlEnvelopeBaseSchema>;

export const AuthStatusResultSchema = lazyZodSchema(() => z.looseObject({
  authenticated: z.literal(true),
  encryption: z.looseObject({
    type: z.enum(['legacy', 'dataKey']),
  }),
  machineRegistered: z.boolean(),
  machineId: z.optional(z.string().check(z.minLength(1))),
  host: z.string().check(z.minLength(1)),
  happyHomeDir: z.string().check(z.minLength(1)),
  daemonRunning: z.boolean(),
}));
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;

export { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY } from '../../voice/sessionBinding.js';

export function createSessionMetadataSchema(zod: typeof z) {
  return zod.looseObject({
      systemSessionV1: zod.optional(createSessionSystemSessionV1Schema(zod)),
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: z.optional(SessionUsageLimitRecoveryV1Schema),
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: z.optional(SessionRunnerRuntimeStateV1Schema),
      [SESSION_PENDING_QUEUE_HOLD_METADATA_KEY]: z.optional(SessionPendingQueueHoldV1Schema),
      [SESSION_EXPLICIT_STOP_METADATA_KEY]: z.optional(SessionExplicitStopV1Schema),
      [PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY]: z.optional(ProviderAccountUsageRefsV1Schema),
      [CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY]:
        z.optional(createConnectedServiceMaterializationIdentityV1Schema(zod)),
      [SESSION_WORKSPACE_LOCATION_METADATA_KEY]:
        z.optional(createSessionWorkspaceLocationV1Schema(zod)),
    });
}

export const SessionMetadataSchema = lazyZodSchema(() => createSessionMetadataSchema(z));
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;


export const SessionShareSchema = lazyZodSchema(() => z.looseObject({
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.boolean(),
  }));
export type SessionShare = z.infer<typeof SessionShareSchema>;

function refineSessionMetadataLayoutVersion(version: number, context: z.core.$RefinementCtx): boolean {
  if (version === 0 || version === 1) return true;
  context.addIssue({ code: 'custom', path: ['metadataLayoutVersion'], message: 'Unsupported Session metadata layout' });
  return false;
}

function refineV2SessionMetadataRecipientFields(
  value: Readonly<{
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion?: number;
    displayProjectionV1?: SessionDisplayProjectionV1;
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1 | null;
    agentState?: string | null;
    agentStateVersion?: number;
    share?: SessionShare | null;
    effectiveAccess?: SessionEffectiveAccessV1;
  }>,
  context: z.core.$RefinementCtx,
): void {
  const metadataLayoutVersion = value.metadataLayoutVersion ?? 0;
  if (!refineSessionMetadataLayoutVersion(metadataLayoutVersion, context)) return;

  const hasAgentState = Object.hasOwn(value, 'agentState');
  const hasAgentStateVersion = Object.hasOwn(value, 'agentStateVersion');
  if (metadataLayoutVersion === 0) {
    if (value.displayProjectionV1 !== undefined) {
      context.addIssue({ code: 'custom', path: ['displayProjectionV1'], message: 'Display projection requires layout one' });
    }
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
  const effectiveAccess = value.effectiveAccess;
  if (effectiveAccess) {
    const owner = effectiveAccess.level === 'owner';
    if (owner && (value.share !== null || !hasOwnerMetadata)) {
      context.addIssue({ code: 'custom', path: ['ownerMetadata'], message: 'Owner recipients require their owner projection and explicit owner share role' });
    }
    if (!owner && (hasOwnerMetadata || value.share === null)) {
      context.addIssue({ code: 'custom', path: ['ownerMetadata'], message: 'Non-owner recipients cannot carry an owner projection' });
    }
  } else {
    if (value.share === undefined) {
      context.addIssue({ code: 'custom', path: ['share'], message: 'Layout-one records require an explicit recipient share role' });
    }
    if (value.share !== undefined && value.share !== null && hasOwnerMetadata) {
      context.addIssue({ code: 'custom', path: ['ownerMetadata'], message: 'Shared-recipient records cannot carry owner metadata' });
    }
    if (value.share === null && !hasOwnerMetadata) {
      context.addIssue({ code: 'custom', path: ['ownerMetadata'], message: 'Owner-recipient records require owner metadata' });
    }
  }

  const projection = {
    ...(value.displayProjectionV1 !== undefined ? { displayProjectionV1: value.displayProjectionV1 } : {}),
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
  if (value.displayProjectionV1 !== undefined && (value.displayProjectionV1.metadataLayoutVersion !== metadataLayoutVersion
    || value.displayProjectionV1.sourceMetadataVersion !== value.metadataVersion)) {
    context.addIssue({ code: 'custom', path: ['displayProjectionV1'], message: 'Display projection must match its metadata tuple' });
  }
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

function refineSessionResponsibilityFields(value: {
  responsibleAccountId?: string | null;
  responsibleAccount?: { accountId: string } | null;
}, ctx: z.core.$RefinementCtx) {
  const id = value.responsibleAccountId;
  const summary = value.responsibleAccount;
  if (id === undefined && summary !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'responsibleAccount without responsibleAccountId is unsupported', path: ['responsibleAccount'] });
  }
  if (id !== undefined && summary === undefined) {
    ctx.addIssue({ code: 'custom', message: 'responsibleAccountId requires an explicit responsibleAccount projection', path: ['responsibleAccount'] });
  }
  if (id === null && summary !== undefined && summary !== null) {
    ctx.addIssue({ code: 'custom', message: 'unassigned responsibility must project a null summary', path: ['responsibleAccount'] });
  }
  if (typeof id === 'string' && summary !== undefined && (summary === null || summary.accountId !== id)) {
    ctx.addIssue({ code: 'custom', message: 'assigned responsibility must project the matching summary', path: ['responsibleAccount'] });
  }
}

export const V2SessionRecordSchema = lazyZodSchema(() => z.looseObject({
    displayProjectionV1: z.optional(SessionDisplayProjectionV1Schema),
    /** Owner detail only: Home-written inference selection witness, never caller metadata or current broker authority. */
    acceptedTeamCredentialBinding: z.optional(z.nullable(SessionTeamCredentialBindingIntentV1Schema)),
    id: z.string().check(z.minLength(1)),
    /** Canonical immutable Session owner, absent on Homes predating this projection. */
    ownerAccountId: z.optional(z.string().check(z.minLength(1))),
    /** Home-local accepted Project identity; absent/null means not yet published. */
    projectKey: z.optional(z.nullable(z.string())),
    origin: z.optional(SessionAwarenessOriginV1Schema),
    workDepth: z.optional(SessionWorkDepthV1Schema),
    manager: z.optional(SessionManagerV1Schema),
    managedSessions: z.optional(SessionManagedSessionsV1Schema),
    /** Viewer-private derived rule membership. Omitted when its authority is unavailable. */
    receivedRuleCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingReviewRuns: z.optional(z.number().check(z.int(), z.nonnegative())),
    seq: z.number().check(z.int(), z.nonnegative()),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    meaningfulActivityAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    active: z.boolean(),
    activeAt: z.number().check(z.int(), z.nonnegative()),
    archivedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    encryptionMode: z.optional(AccountEncryptionModeSchema),
    metadata: z.string(),
    metadataVersion: z.number().check(z.int(), z.nonnegative()),
    metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    ownerMetadata:
      z.optional(z.nullable(StoredSessionOwnerMetadataEnvelopeV1Schema)),
    agentState: z.optional(z.nullable(z.string())),
    agentStateVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    lastViewedSessionSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    unreadSince: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    viewer: z.optional(SessionViewerProjectionV1Schema),
    pendingPermissionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingUserActionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingRequestObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    pendingCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingBlockedCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingActivationAuthorization: z.optional(PendingActivationAuthorizationV1Schema),
    pendingActivationFailureDetails: z.optional(PendingActivationFailureDetailsV1Schema),
    dataEncryptionKey: z.nullable(z.string()),
    /**
     * The one human Account currently responsible for this Session.
     *
     * Omitted means this producer does not support or did not project
     * responsibility; it is never proof that nobody is assigned. Explicit
     * `null` is a supporting producer stating the Session is unassigned.
     */
    responsibleAccountId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    /**
     * The safe current summary for `responsibleAccountId`, projected at
     * read/mutation/event time through the shared safe projector. `null`
     * when unassigned; omitted exactly when `responsibleAccountId` is omitted.
     */
    responsibleAccount: z.optional(z.nullable(SessionAccessAccountSummaryV1Schema)),
    share: z.optional(z.nullable(SessionShareSchema)),
    effectiveAccess: z.optional(SessionEffectiveAccessV1Schema),
    /** Safe audience-existence signal; never a roster or authorization input. */
    hasOtherNamedCollaborator: z.optional(z.boolean()),
    latestTurnId: z.optional(z.nullable(TurnIdSchema)),
    latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
    latestTurnStatusObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    runtimeActivityState: z.optional(SessionRuntimeActivityStateSchema),
    runtimeActivityActiveCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    runtimeActivityObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    runtimeActivityRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
    rollbackEligibleTurnStarts: z.optional(z.array(z.number().check(z.int(), z.nonnegative()))),
    latestReadyEventSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    latestReadyEventAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    thinking: z.optional(z.boolean()),
    thinkingAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    currentStorageState: z.optional(ExternalSessionStorageStateV1Schema),
    acceptedThroughServerSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    materializedThroughSourceAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    publishedThroughServerSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    transcriptShareable: z.optional(z.boolean()),
  }).check(z.superRefine(refineV2SessionMetadataRecipientFields), z.superRefine(refineRuntimeActivityProjectionFields), z.superRefine(refineSessionResponsibilityFields)));
export type V2SessionRecord = z.infer<typeof V2SessionRecordSchema>;

/** List rows describe remote document revisions; they never replace full documents. */
export const V2SessionListRowSchema = lazyZodSchema(() => z.looseObject({
    ...V2SessionRecordSchema.shape,
    documents: z.literal('omitted'),
    metadataAudience: z.enum(['owner', 'shared']),
    agentStateDocument: z.enum(['omitted', 'redacted']),
    metadataLayoutVersion: z.number().check(z.int(), z.nonnegative()),
    agentStateVersion: z.number().check(z.int(), z.nonnegative()),
    metadata: z.optional(z.never()),
    ownerMetadata: z.optional(z.never()),
    agentState: z.optional(z.never()),
  }).check(z.superRefine(refineRuntimeActivityProjectionFields), z.superRefine(refineSessionResponsibilityFields), z.superRefine((value, ctx) => {
    if (!refineSessionMetadataLayoutVersion(value.metadataLayoutVersion, ctx)) return;
    const shared = value.metadataAudience === 'shared';
    if (shared && value.metadataLayoutVersion !== 1) {
      ctx.addIssue({ code: 'custom', path: ['metadataLayoutVersion'], message: 'Shared metadata requires the recipient-safe layout' });
    }
    if (value.agentStateDocument !== (shared ? 'redacted' : 'omitted')) {
      ctx.addIssue({ code: 'custom', path: ['agentStateDocument'], message: 'Agent state disposition must match the admitted recipient' });
    }
    if (value.displayProjectionV1 !== undefined) {
      if (value.displayProjectionV1.sourceMetadataVersion !== value.metadataVersion
        || value.displayProjectionV1.metadataLayoutVersion !== value.metadataLayoutVersion) {
        ctx.addIssue({ code: 'custom', path: ['displayProjectionV1'], message: 'Display projection must match its metadata tuple' });
      }
      if (shared && value.displayProjectionV1.owner !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['displayProjectionV1', 'owner'], message: 'Shared recipients cannot carry owner display' });
      }
    }
    if (value.effectiveAccess !== undefined && (value.effectiveAccess.level === 'owner') === shared) {
      ctx.addIssue({ code: 'custom', path: ['metadataAudience'], message: 'Metadata audience must match admitted access' });
    }
  })));
export type V2SessionListRow = z.infer<typeof V2SessionListRowSchema>;

export const SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2 = 4;
export const SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 = 256;

const SessionLookupTagV2Schema = lazyZodSchema(() => z
  .string().check(z.minLength(1), maxCodeUnits(SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2)));

export const SessionLookupByTagsRequestV2Schema = lazyZodSchema(() => z.strictObject({
    tags: z
      .array(SessionLookupTagV2Schema).check(z.minLength(1), z.maxLength(SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2), z.refine((tags) => new Set(tags).size === tags.length, {
        message: 'Session lookup tags must be unique',
      })),
  }));
export type SessionLookupByTagsRequestV2 = z.infer<typeof SessionLookupByTagsRequestV2Schema>;

export const SessionLookupByTagsResponseV2Schema = lazyZodSchema(() => z.strictObject({
    sessions: z.array(V2SessionRecordSchema).check(z.maxLength(SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2)),
  }));
export type SessionLookupByTagsResponseV2 = z.infer<typeof SessionLookupByTagsResponseV2Schema>;

/**
 * The canonical server-owned proof used only to admit one new
 * session-scoped dynamic Resource context. It deliberately carries no Session
 * record, no Resource identity, and no inventory: authorization belongs to
 * the Session-access owner, while Resource lifetime stays local to its owner.
 */
export const V2SessionResourceAccessResponseSchema = lazyZodSchema(() => z.strictObject({
    accountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    throughCursor: z.number().check(z.int(), z.nonnegative()),
    status: z.enum(['available', 'unavailable']),
  }));
export type V2SessionResourceAccessResponse = z.infer<typeof V2SessionResourceAccessResponseSchema>;

export const V2SessionListResponseSchema = lazyZodSchema(() => z.looseObject({
    sessions: z.array(V2SessionListRowSchema),
    nextCursor: z.optional(z.nullable(z.string())),
    hasNext: z.optional(z.boolean()),
    attentionNextCursor: z.optional(z.nullable(z.string())),
    attentionHasNext: z.optional(z.boolean()),
    // Rows selected but omitted because their owning Account has not migrated
    // Session metadata to the current layout. One unmigrated historical share
    // never refuses the whole page; the refusal stays visible through this
    // count instead of silently shrinking the page.
    metadataUpgradeRequiredCount: z.optional(SessionListMetadataUpgradeRequiredCountSchema),
  }));
export type V2SessionListResponse = z.infer<typeof V2SessionListResponseSchema>;

export const V2SessionByIdResponseSchema = lazyZodSchema(() => z.looseObject({
    session: V2SessionRecordSchema,
    created: z.optional(z.boolean()),
    organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
  }));
export type V2SessionByIdResponse = z.infer<typeof V2SessionByIdResponseSchema>;

export const V2SessionByIdNotFoundSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('Session not found'),
}));
export type V2SessionByIdNotFound = z.infer<typeof V2SessionByIdNotFoundSchema>;

export const V2SessionMessageResponseSchema = lazyZodSchema(() => z.looseObject({
    didWrite: z.boolean(),
    message: z.looseObject({
        id: z.string().check(z.minLength(1)),
        seq: z.number().check(z.int(), z.nonnegative()),
        localId: z.nullable(z.string()),
        createdAt: z.number().check(z.int(), z.nonnegative()),
      }),
  }));
export type V2SessionMessageResponse = z.infer<typeof V2SessionMessageResponseSchema>;

export const SessionStatusResultSchema = lazyZodSchema(() => z.looseObject({
  session: SessionSummarySchema,
  acceptedWorkspace: z.optional(SessionAcceptedWorkspaceV1Schema),
  agentTarget: z.optional(AgentExecutionTargetV1Schema),
  // Content-free Session selection; omitted when its owner metadata cannot be opened.
  connectedServices: z.optional(ConnectedServiceBindingsV2Schema),
  readiness: z.optional(SessionReadinessV1Schema),
  awareness: z.optional(SessionAwarenessProjectionV1Schema),
  // Omitted by older readers; null means request content could not be opened.
  pendingRequests: z.nullish(z.array(z.strictObject({
    requestId: SessionPermissionRequestIdV1Schema,
    turnId: z.optional(TurnIdSchema),
    kind: z.enum(['permission', 'user_action']),
    tool: z.string(),
  }))),
  agentState: z.nullish(z.looseObject({
    controlledByUser: z.optional(z.boolean()),
    pendingRequestsCount: z.number().check(z.int(), z.nonnegative()),
  })),
}));
export type SessionStatusResult = z.infer<typeof SessionStatusResultSchema>;

/** The existing status envelope, now with a typed optional diagnostic projection. */
export const SessionStatusActionResultV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({ ...SessionStatusResultSchema.shape, ok: z.optional(z.literal(true)) }),
  z.strictObject({ ok: z.literal(false), code: z.string(), candidates: z.optional(z.array(z.string())) }),
]));
export const SessionStatusActionResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SessionStatusActionResultV1Schema));

export const SessionCreateResultSchema = lazyZodSchema(() => z.looseObject({
  session: SessionSummarySchema,
  created: z.boolean(),
}));
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export const SessionSendResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  localId: PendingLocalIdSchema,
  waited: z.boolean(),
}));
export type SessionSendResult = z.infer<typeof SessionSendResultSchema>;

export const SessionWaitResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  idle: z.literal(true),
  observedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionWaitResult = z.infer<typeof SessionWaitResultSchema>;

export const SessionStopCleanupIncompleteReasonSchema = lazyZodSchema(() => z.enum(([
  'terminal_control_serviceability_retirement_failed',
  'terminal_attachment_descriptor_retirement_failed',
] as const).map((value) => { if (!StopSessionIncompleteReasonSchema.options.includes(value)) throw new Error(`Key ${value} not found in enum`); return value; })));
export type SessionStopCleanupIncompleteReason = z.infer<typeof SessionStopCleanupIncompleteReasonSchema>;

const SessionStopPhysicalUnconfirmedReasonSchema = lazyZodSchema(() => z.union([
  z.enum(StopSessionIncompleteReasonSchema.options.filter((value): value is Exclude<(typeof StopSessionIncompleteReasonSchema.options)[number], 'terminal_control_serviceability_retirement_failed' | 'terminal_attachment_descriptor_retirement_failed'> => !([
    'terminal_control_serviceability_retirement_failed',
    'terminal_attachment_descriptor_retirement_failed',
  ] as readonly string[]).includes(value))),
  z.enum([
    'transport_ambiguous',
    'marker_fallback_failed',
    'local_session_not_found',
    'target_daemon_unavailable',
    'target_session_not_found',
    'daemon_stop_requested',
    'unexpected_error',
  ]),
]));

export const SessionStopOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
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
  z.strictObject({
    status: z.literal('already_stopped'),
    reason: z.literal('no_runtime_session_inactive'),
  }),
  z.strictObject({
    status: z.literal('stopped_projection_unconfirmed'),
    reason: z.literal('relay_inactive_not_observed'),
  }),
  z.strictObject({
    status: z.literal('stopped_cleanup_incomplete'),
    reason: SessionStopCleanupIncompleteReasonSchema,
  }),
  z.strictObject({
    status: z.literal('physical_stop_unconfirmed'),
    reason: SessionStopPhysicalUnconfirmedReasonSchema,
  }),
]));
export type SessionStopOutcome = z.infer<typeof SessionStopOutcomeSchema>;

const SessionStopResultBaseSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().check(z.minLength(1)),
}));

export const SessionStopResultSchema = lazyZodSchema(() => z.discriminatedUnion('stopped', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(SessionStopResultBaseSchema, {
    stopped: z.literal(true),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(SessionStopResultBaseSchema, {
    stopped: z.literal(false),
    // cli-v0.2.0 and cli-v0.2.1 emitted `{ stopped: false }`; keep reading that
    // released shape while current writers add the structured reason.
    stopOutcome: z.optional(SessionStopOutcomeSchema),
  })),
]));
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

export const SessionArchiveResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  archivedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionArchiveResult = z.infer<typeof SessionArchiveResultSchema>;

/** Retained archive HTTP body; Action selection and report scope stay separate. */
export const SessionArchiveHttpBodyV1Schema = lazyZodSchema(() => z.nullish(z.strictObject({
  originRunId: z.optional(z.string().check(z.minLength(1))),
})));

/** Action-owned direct-report scope; omission keeps the incumbent parent-only operation. */
export const SessionArchiveActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  alsoArchiveReports: z.optional(z.boolean()),
}));

const SessionArchiveReportIdentityV1 = {
  sessionId: z.string().check(z.minLength(1)),
  title: z.optional(z.string()),
};
export const SessionArchiveReportOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ ...SessionArchiveReportIdentityV1, status: z.literal('archived') }),
  z.strictObject({ ...SessionArchiveReportIdentityV1, status: z.literal('failed'), errorCode: z.string(), error: z.string() }),
  z.strictObject({ ...SessionArchiveReportIdentityV1, status: z.literal('approval_pending'), artifactId: z.string().check(z.minLength(1)) }),
]));
export type SessionArchiveReportOutcomeV1 = z.infer<typeof SessionArchiveReportOutcomeV1Schema>;
export const SessionArchiveActionResultV1Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  archivedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  reports: z.optional(z.array(SessionArchiveReportOutcomeV1Schema)),
  reportsError: z.optional(z.strictObject({ errorCode: z.string(), error: z.string() })),
}));
export type SessionArchiveActionResultV1 = z.infer<typeof SessionArchiveActionResultV1Schema>;

export const SessionUnarchiveResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  archivedAt: z.null(),
}));
export type SessionUnarchiveResult = z.infer<typeof SessionUnarchiveResultSchema>;

export const SessionSetTitleResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
}));
export type SessionSetTitleResult = z.infer<typeof SessionSetTitleResultSchema>;

export const SessionSetPermissionModeResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  permissionMode: z.string().check(z.minLength(1)),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionSetPermissionModeResult = z.infer<typeof SessionSetPermissionModeResultSchema>;

export const SessionSetModelResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  modelId: z.string().check(z.minLength(1)),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionSetModelResult = z.infer<typeof SessionSetModelResultSchema>;

export const SessionHistoryCompactMessageSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  role: z.string().check(z.minLength(1)),
  kind: z.string().check(z.minLength(1)),
  text: z.string(),
  structuredKind: z.optional(z.string().check(z.minLength(1))),
}));
export type SessionHistoryCompactMessage = z.infer<typeof SessionHistoryCompactMessageSchema>;

export const SessionHistoryRawMessageSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  role: z.string().check(z.minLength(1)),
  raw: z.record(z.string(), z.unknown()),
}));
export type SessionHistoryRawMessage = z.infer<typeof SessionHistoryRawMessageSchema>;

export const SessionHistoryResultSchema = lazyZodSchema(() => z.discriminatedUnion('format', [
  z.looseObject({
    sessionId: z.string().check(z.minLength(1)),
    format: z.literal('compact'),
    messages: z.array(SessionHistoryCompactMessageSchema),
  }),
  z.looseObject({
    sessionId: z.string().check(z.minLength(1)),
    format: z.literal('raw'),
    messages: z.array(SessionHistoryRawMessageSchema),
  }),
]));
export type SessionHistoryResult = z.infer<typeof SessionHistoryResultSchema>;

export const SessionRunStartResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runId: z.string().check(z.minLength(1)),
  callId: z.string().check(z.minLength(1)),
  intent: z.string().check(z.minLength(1)),
  backendId: z.string().check(z.minLength(1)),
}));
export type SessionRunStartResult = z.infer<typeof SessionRunStartResultSchema>;

export const SessionRunListResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runs: z.array(ExecutionRunPublicStateSchema),
}));
export type SessionRunListResult = z.infer<typeof SessionRunListResultSchema>;

export const SessionRunGetResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  run: ExecutionRunPublicStateSchema,
  latestToolResult: z.optional(SubAgentRunResultV2Schema),
  structuredMeta: z.optional(z.looseObject({ kind: z.string().check(z.minLength(1)), payload: z.unknown() })),
}));
export type SessionRunGetResult = z.infer<typeof SessionRunGetResultSchema>;

export const SessionRunSendResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runId: z.string().check(z.minLength(1)),
  sent: z.literal(true),
}));
export type SessionRunSendResult = z.infer<typeof SessionRunSendResultSchema>;

export const SessionRunStopResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runId: z.string().check(z.minLength(1)),
  stopped: z.literal(true),
}));
export type SessionRunStopResult = z.infer<typeof SessionRunStopResultSchema>;

export const SessionRunActionResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runId: z.string().check(z.minLength(1)),
  actionId: z.string().check(z.minLength(1)),
  updatedToolResult: z.optional(SubAgentRunResultV2Schema),
}));
export type SessionRunActionResult = z.infer<typeof SessionRunActionResultSchema>;

export const SessionRunWaitResultSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  runId: z.string().check(z.minLength(1)),
  status: ExecutionRunTerminalStatusSchema,
}));
export type SessionRunWaitResult = z.infer<typeof SessionRunWaitResultSchema>;

export const SessionRunStreamStartResultSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)((<A extends z.ZodMiniObject, B extends z.ZodMiniObject>(a: A, b: B) => z.core.util.merge(a, b) as z.ZodMiniObject<z.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(z
  .object({
    sessionId: z.string().check(z.minLength(1)),
    runId: z.string().check(z.minLength(1)),
  }), ExecutionRunTurnStreamStartResponseSchema)));
export type SessionRunStreamStartResult = z.infer<typeof SessionRunStreamStartResultSchema>;

export const SessionRunStreamReadResultSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)((<A extends z.ZodMiniObject, B extends z.ZodMiniObject>(a: A, b: B) => z.core.util.merge(a, b) as z.ZodMiniObject<z.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(z
  .object({
    sessionId: z.string().check(z.minLength(1)),
    runId: z.string().check(z.minLength(1)),
  }), ExecutionRunTurnStreamReadResponseSchema)));
export type SessionRunStreamReadResult = z.infer<typeof SessionRunStreamReadResultSchema>;

export const SessionRunStreamCancelResultSchema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.minLength(1)),
    runId: z.string().check(z.minLength(1)),
    streamId: z.string().check(z.minLength(1)),
    cancelled: z.literal(true),
  }));
export type SessionRunStreamCancelResult = z.infer<typeof SessionRunStreamCancelResultSchema>;

export const SessionListEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_list'),
  data: SessionListResultSchema,
}));

export const SessionHistoryEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_history'),
  data: SessionHistoryResultSchema,
}));

export const SessionRunGetEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_get'),
  data: SessionRunGetResultSchema,
}));

export const SessionStatusEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_status'),
  data: SessionStatusResultSchema,
}));

export const SessionCreateEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_create'),
  data: SessionCreateResultSchema,
}));

export const SessionSendEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_send'),
  data: SessionSendResultSchema,
}));

export const SessionWaitEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_wait'),
  data: SessionWaitResultSchema,
}));

export const SessionStopEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_stop'),
  data: SessionStopResultSchema,
}));

export const SessionArchiveEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_archive'),
  data: SessionArchiveResultSchema,
}));

export const SessionUnarchiveEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_unarchive'),
  data: SessionUnarchiveResultSchema,
}));

export const SessionSetTitleEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_set_title'),
  data: SessionSetTitleResultSchema,
}));

export const SessionSetPermissionModeEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_set_permission_mode'),
  data: SessionSetPermissionModeResultSchema,
}));

export const SessionSetModelEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_set_model'),
  data: SessionSetModelResultSchema,
}));

export const SessionRunStartEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_start'),
  data: SessionRunStartResultSchema,
}));

export const SessionRunListEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_list'),
  data: SessionRunListResultSchema,
}));

export const SessionRunSendEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_send'),
  data: SessionRunSendResultSchema,
}));

export const SessionRunStopEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_stop'),
  data: SessionRunStopResultSchema,
}));

export const SessionRunActionEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_action'),
  data: SessionRunActionResultSchema,
}));

export const SessionRunWaitEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_wait'),
  data: SessionRunWaitResultSchema,
}));

export const SessionRunStreamStartEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_stream_start'),
  data: SessionRunStreamStartResultSchema,
}));

export const SessionRunStreamReadEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_stream_read'),
  data: SessionRunStreamReadResultSchema,
}));

export const SessionRunStreamCancelEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_run_stream_cancel'),
  data: SessionRunStreamCancelResultSchema,
}));

export const AuthStatusEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('auth_status'),
  data: AuthStatusResultSchema,
}));

export const SessionControlActionSpecSummarySchema = ActionDefinitionSummaryV1Schema;
export type SessionControlActionSpecSummary = z.infer<typeof SessionControlActionSpecSummarySchema>;

export const SessionActionsListResultSchema = lazyZodSchema(() => z.looseObject({
    actionSpecs: z.array(SessionControlActionSpecSummarySchema),
  }));
export type SessionActionsListResult = z.infer<typeof SessionActionsListResultSchema>;

export const SessionActionsDescribeResultSchema = lazyZodSchema(() => z.looseObject({
    actionSpec: SessionControlActionSpecSummarySchema,
  }));
export type SessionActionsDescribeResult = z.infer<typeof SessionActionsDescribeResultSchema>;

export const SessionActionsExecuteResultSchema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.minLength(1)),
    actionId: ActionDefinitionIdV1Schema,
    result: z.unknown(),
  }));
export type SessionActionsExecuteResult = z.infer<typeof SessionActionsExecuteResultSchema>;

export const SessionActionsListEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_actions_list'),
  data: SessionActionsListResultSchema,
}));

export const SessionActionsDescribeEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_actions_describe'),
  data: SessionActionsDescribeResultSchema,
}));

export const SessionActionsExecuteEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('session_actions_execute'),
  data: SessionActionsExecuteResultSchema,
}));
