import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import {
  ExternalSessionAgentIdSchema,
  ExternalSessionsSourceSchema,
} from '../../external/sourceCatalog.js';
import { RuntimeDescriptorV1Schema } from '../../metadata/runtimeDescriptorV1.js';
import { AgentExecutionTargetV1Schema } from '../../../agents/executionTargetV1.js';
import { NonBlankOpaqueIdentifierSchema } from '../../../strings/opaqueIdentifier.js';

import {
  SessionHandoffStorageModeSchema,
  SessionHandoffStateTransferSchema,
  SessionHandoffTransportStrategySchema,
} from './handoffTypes.js';
import {
  HandoffWorkspaceActionV1Schema,
  HandoffWorkspaceOutcomeV1Schema,
} from './workspaceSyncSchemas.js';
import {
  SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH,
  SessionHandoffProgressCheckpointSchema,
  SessionHandoffPrepareTargetFailureCodeSchema,
  SessionHandoffPrepareTargetFailureSchema,
  SessionHandoffProgressWarningCodeSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspacePreflightSummarySchema,
} from './handoffStatus.js';
import { TransferChunkEnvelopeSchema, TransferEndpointCandidateSchema } from '../../../machines/transfer/transferStream.js';

const MAX_HANDOFF_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_JOB_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_TRANSFER_ID_LENGTH = 512;
const MAX_MANIFEST_HASH_LENGTH = 256;
const MAX_PREFERRED_TRANSPORT_STRATEGIES = 4;
const MAX_ATTEMPT_ID_LENGTH = 256;

/** Additive read projection; only explicit true capability flags admit optional modes. */
export const SessionHandoffCapabilityV3Schema = lazyZodSchema(() => z.object({
  protocolVersion: z.literal(3),
  atomicTargetResume: z.boolean(),
  targetCleanup: z.boolean(),
  sameMachineHandoff: z.pipe(z.optional(z.unknown()), z.transform((value) => value === true)),
  existingState: z.pipe(z.optional(z.unknown()), z.transform((value) => value === true)),
}));
export type SessionHandoffCapabilityV3 = z.infer<typeof SessionHandoffCapabilityV3Schema>;

const LEGACY_HANDOFF_TRANSFER_INLINE_FIELDS = [
  'workspaceManifestHash',
  'transferredPayload',
  'agentBundle',
  'workspaceArtifacts',
] as const;

function rejectLegacyInlineTransferFields(
  value: Record<string, unknown>,
  context: z.core.$RefinementCtx,
): void {
  for (const key of LEGACY_HANDOFF_TRANSFER_INLINE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `legacy inline handoff transfer field "${key}" is not supported`,
      });
    }
  }
}

function rejectRetiredWorkspaceActionFields(
  value: Record<string, unknown>,
  context: z.core.$RefinementCtx,
): void {
  if (Object.prototype.hasOwnProperty.call(value, 'workspaceTransfer')) {
    context.addIssue({
      code: "custom",
      path: ['workspaceTransfer'],
      message: 'workspaceTransfer is retired; use workspaceAction',
    });
  }
}

const SessionHandoffAgentBundleTransferPublicationSchema = lazyZodSchema(() => z.looseObject({
    transferId: z.string().check(z.minLength(1), z.maxLength(MAX_TRANSFER_ID_LENGTH)),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
    manifestHash: z.string().check(z.minLength(1), z.maxLength(MAX_MANIFEST_HASH_LENGTH)),
    // Preserve all routes, including those advertised by supported predecessor daemons.
    endpointCandidates: z.optional(z.readonly(z.array(TransferEndpointCandidateSchema))),
  }));
export type SessionHandoffAgentBundleTransferPublication = z.infer<
  typeof SessionHandoffAgentBundleTransferPublicationSchema
>;

function areEquivalentHandoffPublicationValues(
  left: unknown,
  right: unknown,
  leftAncestors: ReadonlySet<object> = new Set(),
  rightAncestors: ReadonlySet<object> = new Set(),
): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (leftAncestors.has(left) || rightAncestors.has(right)) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const nextLeftAncestors = new Set(leftAncestors).add(left);
    const nextRightAncestors = new Set(rightAncestors).add(right);
    return left.every((value, index) => areEquivalentHandoffPublicationValues(
      value,
      right[index],
      nextLeftAncestors,
      nextRightAncestors,
    ));
  }
  if (
    (Object.getPrototypeOf(left) !== Object.prototype && Object.getPrototypeOf(left) !== null)
    || (Object.getPrototypeOf(right) !== Object.prototype && Object.getPrototypeOf(right) !== null)
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  const nextLeftAncestors = new Set(leftAncestors).add(left);
  const nextRightAncestors = new Set(rightAncestors).add(right);
  return leftKeys.every((key) => areEquivalentHandoffPublicationValues(
    leftRecord[key],
    rightRecord[key],
    nextLeftAncestors,
    nextRightAncestors,
  ));
}

export const SessionHandoffMetadataV2Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    agentBundleTransferPublication: z.optional(SessionHandoffAgentBundleTransferPublicationSchema),
    workspaceSeedTransferPublication: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(SessionHandoffAgentBundleTransferPublicationSchema)),
    // Prospective remote-dev persisted prepare-target records used the Provider-era field.
    // Remove this reader only after no supported predecessor produces it and retained jobs are reconciled.
    providerBundleTransferPublication: z.optional(SessionHandoffAgentBundleTransferPublicationSchema),
  }).check(z.superRefine((value, context) => {
    if (
      value.agentBundleTransferPublication
      && value.providerBundleTransferPublication
      && !areEquivalentHandoffPublicationValues(
        value.agentBundleTransferPublication,
        value.providerBundleTransferPublication,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ['providerBundleTransferPublication'],
        message: 'legacy and canonical Agent bundle transfer publications must match',
      });
    }
  })), z.transform((value) => {
    const {
      agentBundleTransferPublication,
      providerBundleTransferPublication,
      ...metadata
    } = value;
    const normalizedAgentBundleTransferPublication =
      agentBundleTransferPublication ?? providerBundleTransferPublication;
    return {
      ...metadata,
      ...(normalizedAgentBundleTransferPublication
        ? { agentBundleTransferPublication: normalizedAgentBundleTransferPublication }
        : {}),
    };
  })));
export type SessionHandoffMetadataV2 = z.infer<typeof SessionHandoffMetadataV2Schema>;

const SessionHandoffResumePlanSchema = lazyZodSchema(() => z.looseObject({
    directory: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
    directoryKind: z.optional(z.enum(['path', 'managed'])),
    agent: ExternalSessionAgentIdSchema,
    /** Canonical current target; absent only on supported predecessor responses. */
    agentTarget: z.optional(AgentExecutionTargetV1Schema),
    /** The Agent's own resume token, handed back to its issuer byte-for-byte. */
    resume: NonBlankOpaqueIdentifierSchema.check(z.maxLength(4096)),
    environmentVariables: z.optional(z.record(z.string().check(z.minLength(1), z.maxLength(128)), z.string().check(z.maxLength(16 * 1024)))),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
  }).check(z.superRefine((value, context) => {
    if (Object.prototype.hasOwnProperty.call(value, 'experimentalCodexAcp')) {
      context.addIssue({
        code: "custom",
        path: ['experimentalCodexAcp'],
        message: 'experimentalCodexAcp is not supported',
      });
    }
  })));
export type SessionHandoffResumePlan = z.infer<typeof SessionHandoffResumePlanSchema>;

/** One policy owner shared by the public Action and daemon request boundaries. */
export function refineSessionHandoffStateTransferV3(
  value: Readonly<{
    stateTransfer?: 'transfer' | 'existing';
    targetDirectory?: Readonly<{ kind: string }>;
    workspaceAction?: Readonly<{ kind: string }>;
    handoffMetadataV2?: Record<string, unknown>;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (value.stateTransfer !== 'existing') return;
  if (value.targetDirectory?.kind === 'managed') {
    context.addIssue({ code: "custom", path: ['targetDirectory'], message: 'Existing session state requires an existing target directory' });
  }
  if (value.workspaceAction && value.workspaceAction.kind !== 'none') {
    context.addIssue({ code: "custom", path: ['workspaceAction'], message: 'Existing session state requires workspaceAction none' });
  }
  for (const key of ['agentBundleTransferPublication', 'providerBundleTransferPublication', 'workspaceSeedTransferPublication', 'workspaceReplicationManifestTransferPublication'] as const) {
    if (value.handoffMetadataV2 && Object.prototype.hasOwnProperty.call(value.handoffMetadataV2, key)) {
      context.addIssue({ code: "custom", path: ['handoffMetadataV2', key], message: 'Existing session state cannot publish transferred state' });
    }
  }
}

/** Read-only target admission before any source quiescence or transfer effect. */
export const SessionHandoffExistingStateCheckRequestV3Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
  sourceMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  sourceSessionStorageMode: SessionHandoffStorageModeSchema,
  targetSessionStorageMode: z.optional(SessionHandoffStorageModeSchema),
}));
export type SessionHandoffExistingStateCheckRequestV3 = z.infer<typeof SessionHandoffExistingStateCheckRequestV3Schema>;

export const SessionHandoffExistingStateCheckResponseV3Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.string().check(z.minLength(1)),
    error: z.optional(z.string().check(z.minLength(1), z.maxLength(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH))),
  }),
]));
export type SessionHandoffExistingStateCheckResponseV3 = z.infer<typeof SessionHandoffExistingStateCheckResponseV3Schema>;

export const SessionHandoffStartRequestSchema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    sourceMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
    targetMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
    operationId: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH))),
    targetDirectory: z.optional(z.strictObject({ kind: z.literal('managed') })),
    /** Host-derived Account Home scope for daemon-owned relationship creation. */
    accountServerId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH))),
    sessionStorageMode: SessionHandoffStorageModeSchema,
    stateTransfer: z.optional(SessionHandoffStateTransferSchema),
    preferredTransportStrategies: z.readonly(z
      .array(SessionHandoffTransportStrategySchema).check(z.minLength(1), z.maxLength(MAX_PREFERRED_TRANSPORT_STRATEGIES))),
    negotiatedTransportStrategy: z.optional(SessionHandoffTransportStrategySchema),
    workspaceAction: z.optional(HandoffWorkspaceActionV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.targetDirectory?.kind === 'managed' && !value.operationId) {
      context.addIssue({ code: "custom", path: ['operationId'], message: 'Managed handoff requires operation identity' });
    }
  }), z.superRefine(rejectLegacyInlineTransferFields), z.superRefine(refineSessionHandoffStateTransferV3), z.superRefine(rejectRetiredWorkspaceActionFields)));
export type SessionHandoffStartRequest = z.infer<typeof SessionHandoffStartRequestSchema>;

const SessionHandoffPrepareTargetFieldsSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    sourceMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
    targetMachineId: z.string().check(z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
    operationId: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH))),
    sessionId: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH))),
    targetDirectory: z.optional(z.strictObject({ kind: z.literal('managed') })),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema,
    allowServerRoutedFallback: z.optional(z.boolean()),
    sourceSessionStorageMode: SessionHandoffStorageModeSchema,
    stateTransfer: z.optional(SessionHandoffStateTransferSchema),
    targetSessionStorageMode: z.optional(SessionHandoffStorageModeSchema),
    targetPath: z._default(z.string().check(z.maxLength(MAX_PATH_LENGTH)), ''),
    /** Repository materialization root for a git_worktree handoff. */
    workspaceRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH))),
    /** Safe repository-relative cwd; empty means the repository root. */
    workspaceSessionRelativeCwd: z.optional(z.string().check(z.maxLength(MAX_PATH_LENGTH))),
    endpointCandidates: z._default(z.readonly(z
      .array(TransferEndpointCandidateSchema)), () => []),
    handoffMetadataV2: z.optional(SessionHandoffMetadataV2Schema),
    workspaceAction: z.optional(HandoffWorkspaceActionV1Schema),
  }));

function refineSessionHandoffPrepareTargetRequest(
  value: z.infer<typeof SessionHandoffPrepareTargetFieldsSchema>, context: z.core.$RefinementCtx,
): void {
    refineSessionHandoffStateTransferV3(value, context);
    if (value.stateTransfer === 'existing' && !value.sessionId) {
      context.addIssue({ code: "custom", path: ['sessionId'], message: 'Existing session state requires exact Session identity' });
    }
    if (value.targetDirectory?.kind === 'managed') {
      for (const field of ['operationId', 'sessionId'] as const) {
        if (!value[field]) context.addIssue({ code: "custom", path: [field], message: 'Managed handoff requires target allocation identity' });
      }
      if (value.workspaceAction && value.workspaceAction.kind !== 'none') {
        context.addIssue({ code: "custom", path: ['workspaceAction'], message: 'Managed handoff cannot enroll workspace relationships' });
      }
    } else if (!value.targetPath.trim()) {
      context.addIssue({ code: "custom", path: ['targetPath'], message: 'Path handoff requires a target path' });
    }
    if ((value.workspaceRootPath === undefined) !== (value.workspaceSessionRelativeCwd === undefined)) {
      context.addIssue({
        code: "custom",
        path: ['workspaceSessionRelativeCwd'],
        message: 'workspace root and session-relative cwd must be provided together',
      });
    }
}

export const SessionHandoffPrepareTargetRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(SessionHandoffPrepareTargetFieldsSchema).check(z.superRefine(refineSessionHandoffPrepareTargetRequest), z.superRefine(rejectLegacyInlineTransferFields), z.superRefine(rejectRetiredWorkspaceActionFields)));
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

/** Host-private credential transfer is closed and always names the existing Session. */
export const SessionHandoffPrepareTargetPrivateRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionHandoffPrepareTargetFieldsSchema, { sessionId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)) })).check(z.superRefine(refineSessionHandoffPrepareTargetRequest), z.superRefine(rejectLegacyInlineTransferFields), z.superRefine(rejectRetiredWorkspaceActionFields)));

export const SessionHandoffPrepareTargetResultGetRequestSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
  }));
export type SessionHandoffPrepareTargetResultGetRequest = z.infer<typeof SessionHandoffPrepareTargetResultGetRequestSchema>;

export const SessionHandoffPrepareTargetResumeRequestSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    jobId: z.string().check(z.minLength(1), z.maxLength(MAX_JOB_ID_LENGTH), z.regex(/^[A-Za-z0-9._-]+$/u)),
    expectedRevision: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
    attemptId: z.string().check(z.minLength(1), z.maxLength(MAX_ATTEMPT_ID_LENGTH)),
  }));
export type SessionHandoffPrepareTargetResumeRequest = z.infer<
  typeof SessionHandoffPrepareTargetResumeRequestSchema
>;

export const SessionHandoffCommitRequestSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    mode: z.optional(z.enum(['target', 'source_cleanup'])),
  }));
export type SessionHandoffCommitRequest = z.infer<typeof SessionHandoffCommitRequestSchema>;

export const SessionHandoffAbortRequestSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    reason: z.string().check(z.minLength(1), z.maxLength(1024)),
  }));
export type SessionHandoffAbortRequest = z.infer<typeof SessionHandoffAbortRequestSchema>;

export const SessionHandoffStartResponseSchema = lazyZodSchema(() => z.looseObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
    endpointCandidates: z._default(z.readonly(z
      .array(TransferEndpointCandidateSchema)), () => []),
    targetPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
    handoffMetadataV2: z.optional(SessionHandoffMetadataV2Schema),
  }).check(z.superRefine(rejectLegacyInlineTransferFields)));
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

/**
 * The single public terminal result of the `session.handoff` Action. Transport
 * and coordinator success envelopes stay behind their owning adapters; Action
 * callers receive the committed handoff state and any bounded recovery facts.
 */
export const SessionHandoffActionResultV1Schema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
    workspace: HandoffWorkspaceOutcomeV1Schema,
    warning: z.optional(z.strictObject({
        code: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
        message: z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH)),
      })),
  }));
export type SessionHandoffActionResultV1 = z.infer<typeof SessionHandoffActionResultV1Schema>;

export const SessionHandoffPrepareTargetResponseSchema = lazyZodSchema(() => z.looseObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.optional(NonBlankOpaqueIdentifierSchema.check(z.maxLength(MAX_HANDOFF_ID_LENGTH))),
    directSource: z.optional(ExternalSessionsSourceSchema),
    runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
    resume: z.optional(SessionHandoffResumePlanSchema),
  }).check(z.superRefine(rejectLegacyInlineTransferFields)));
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

export const SessionHandoffPrepareTargetResultGetSuccessResponseSchema = lazyZodSchema(() => z.looseObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
    remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    directSource: ExternalSessionsSourceSchema,
    runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
    resume: SessionHandoffResumePlanSchema,
  }));
export type SessionHandoffPrepareTargetResultGetSuccessResponse = z.infer<
  typeof SessionHandoffPrepareTargetResultGetSuccessResponseSchema
>;

const SessionHandoffPrepareTargetResultGetFailureResponseSchema = lazyZodSchema(() => z.discriminatedUnion('errorCode', [
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum([
      'invalid_request',
      'not_found',
    ]),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum([
      'awaiting_recovery',
      'aborted',
      'failed',
      'awaiting_user_resume',
      'reconciliation_required',
      'workspace_sync_update_required',
      'handoff_existing_state_update_required',
    ]),
    error: z
      .string().check(z.minLength(1), z.maxLength(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH)),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: SessionHandoffPrepareTargetFailureCodeSchema,
    error: z
      .string().check(z.minLength(1), z.maxLength(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH)),
  }),
]));

export const SessionHandoffPrepareTargetResultGetResponseSchema = lazyZodSchema(() => z.union([
  SessionHandoffPrepareTargetResultGetSuccessResponseSchema,
  SessionHandoffPrepareTargetResultGetFailureResponseSchema,
]));
export type SessionHandoffPrepareTargetResultGetResponse = z.infer<typeof SessionHandoffPrepareTargetResultGetResponseSchema>;

export const SessionHandoffPrepareTargetResumeErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'not_found',
  'identity_conflict',
  'stale_revision',
  'attempt_conflict',
  'invalid_state',
  'reconciliation_required',
  'internal_error',
]));
export type SessionHandoffPrepareTargetResumeErrorCode = z.infer<
  typeof SessionHandoffPrepareTargetResumeErrorCodeSchema
>;

export const SessionHandoffPrepareTargetResumeResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    jobId: z.string().check(z.minLength(1), z.maxLength(MAX_JOB_ID_LENGTH)),
    transitionRevision: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
    status: SessionHandoffStatusSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: SessionHandoffPrepareTargetResumeErrorCodeSchema,
      message: z.string().check(z.minLength(1), z.maxLength(2_000)),
    }),
  }),
]));
export type SessionHandoffPrepareTargetResumeResponse = z.infer<
  typeof SessionHandoffPrepareTargetResumeResponseSchema
>;

export const SessionHandoffCommitResponseSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
  }));
export type SessionHandoffCommitResponse = z.infer<typeof SessionHandoffCommitResponseSchema>;

export const SessionHandoffAbortResponseSchema = lazyZodSchema(() => z.strictObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
    status: SessionHandoffStatusSchema,
  }));
export type SessionHandoffAbortResponse = z.infer<typeof SessionHandoffAbortResponseSchema>;

export const SessionHandoffStatusGetRequestSchema = lazyZodSchema(() => z.looseObject({
    handoffId: z.string().check(z.minLength(1), z.maxLength(MAX_HANDOFF_ID_LENGTH)),
  }));
export type SessionHandoffStatusGetRequest = z.infer<typeof SessionHandoffStatusGetRequestSchema>;

export {
  HandoffWorkspaceActionV1Schema,
  SessionHandoffProgressCheckpointSchema,
  SessionHandoffPrepareTargetFailureCodeSchema,
  SessionHandoffPrepareTargetFailureSchema,
  SessionHandoffProgressWarningCodeSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspacePreflightSummarySchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
};
