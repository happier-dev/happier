import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
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
  sameMachineHandoff: z.unknown().transform((value) => value === true),
  existingState: z.unknown().transform((value) => value === true),
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
  context: z.RefinementCtx,
): void {
  for (const key of LEGACY_HANDOFF_TRANSFER_INLINE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `legacy inline handoff transfer field "${key}" is not supported`,
      });
    }
  }
}

function rejectRetiredWorkspaceActionFields(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (Object.prototype.hasOwnProperty.call(value, 'workspaceTransfer')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceTransfer'],
      message: 'workspaceTransfer is retired; use workspaceAction',
    });
  }
}

const SessionHandoffAgentBundleTransferPublicationSchema = lazyZodSchema(() => z
  .object({
    transferId: z.string().min(1).max(MAX_TRANSFER_ID_LENGTH),
    sizeBytes: z.number().int().min(0),
    manifestHash: z.string().min(1).max(MAX_MANIFEST_HASH_LENGTH),
    // Preserve all routes, including those advertised by supported predecessor daemons.
    endpointCandidates: z.array(TransferEndpointCandidateSchema).readonly().optional(),
  })
  .passthrough());
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

export const SessionHandoffMetadataV2Schema = lazyZodSchema(() => z
  .object({
    agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublicationSchema.optional(),
    workspaceSeedTransferPublication: SessionHandoffAgentBundleTransferPublicationSchema.strict().optional(),
    // Prospective remote-dev persisted prepare-target records used the Provider-era field.
    // Remove this reader only after no supported predecessor produces it and retained jobs are reconciled.
    providerBundleTransferPublication: SessionHandoffAgentBundleTransferPublicationSchema.optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (
      value.agentBundleTransferPublication
      && value.providerBundleTransferPublication
      && !areEquivalentHandoffPublicationValues(
        value.agentBundleTransferPublication,
        value.providerBundleTransferPublication,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerBundleTransferPublication'],
        message: 'legacy and canonical Agent bundle transfer publications must match',
      });
    }
  })
  .transform((value) => {
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
  }));
export type SessionHandoffMetadataV2 = z.infer<typeof SessionHandoffMetadataV2Schema>;

const SessionHandoffResumePlanSchema = lazyZodSchema(() => z
  .object({
    directory: z.string().min(1).max(MAX_PATH_LENGTH),
    directoryKind: z.enum(['path', 'managed']).optional(),
    agent: ExternalSessionAgentIdSchema,
    /** Canonical current target; absent only on supported predecessor responses. */
    agentTarget: AgentExecutionTargetV1Schema.optional(),
    /** The Agent's own resume token, handed back to its issuer byte-for-byte. */
    resume: NonBlankOpaqueIdentifierSchema.max(4096),
    environmentVariables: z.record(z.string().min(1).max(128), z.string().max(16 * 1024)).optional(),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.prototype.hasOwnProperty.call(value, 'experimentalCodexAcp')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['experimentalCodexAcp'],
        message: 'experimentalCodexAcp is not supported',
      });
    }
  }));
export type SessionHandoffResumePlan = z.infer<typeof SessionHandoffResumePlanSchema>;

/** One policy owner shared by the public Action and daemon request boundaries. */
export function refineSessionHandoffStateTransferV3(
  value: Readonly<{
    stateTransfer?: 'transfer' | 'existing';
    targetDirectory?: Readonly<{ kind: string }>;
    workspaceAction?: Readonly<{ kind: string }>;
    handoffMetadataV2?: Record<string, unknown>;
  }>,
  context: z.RefinementCtx,
): void {
  if (value.stateTransfer !== 'existing') return;
  if (value.targetDirectory?.kind === 'managed') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetDirectory'], message: 'Existing session state requires an existing target directory' });
  }
  if (value.workspaceAction && value.workspaceAction.kind !== 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceAction'], message: 'Existing session state requires workspaceAction none' });
  }
  for (const key of ['agentBundleTransferPublication', 'providerBundleTransferPublication', 'workspaceSeedTransferPublication', 'workspaceReplicationManifestTransferPublication'] as const) {
    if (value.handoffMetadataV2 && Object.prototype.hasOwnProperty.call(value.handoffMetadataV2, key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['handoffMetadataV2', key], message: 'Existing session state cannot publish transferred state' });
    }
  }
}

/** Read-only target admission before any source quiescence or transfer effect. */
export const SessionHandoffExistingStateCheckRequestV3Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  sourceMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
  targetMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
  targetPath: z.string().min(1).max(MAX_PATH_LENGTH),
  sourceSessionStorageMode: SessionHandoffStorageModeSchema,
  targetSessionStorageMode: SessionHandoffStorageModeSchema.optional(),
}).strict());
export type SessionHandoffExistingStateCheckRequestV3 = z.infer<typeof SessionHandoffExistingStateCheckRequestV3Schema>;

export const SessionHandoffExistingStateCheckResponseV3Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.string().min(1),
    error: z.string().min(1).max(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH).optional(),
  }).strict(),
]));
export type SessionHandoffExistingStateCheckResponseV3 = z.infer<typeof SessionHandoffExistingStateCheckResponseV3Schema>;

export const SessionHandoffStartRequestSchema = lazyZodSchema(() => z
  .object({
    sessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    sourceMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    targetMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    operationId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    targetDirectory: z.object({ kind: z.literal('managed') }).strict().optional(),
    /** Host-derived Account Home scope for daemon-owned relationship creation. */
    accountServerId: z.string().trim().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    sessionStorageMode: SessionHandoffStorageModeSchema,
    stateTransfer: SessionHandoffStateTransferSchema.optional(),
    preferredTransportStrategies: z
      .array(SessionHandoffTransportStrategySchema)
      .min(1)
      .max(MAX_PREFERRED_TRANSPORT_STRATEGIES)
      .readonly(),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema.optional(),
    workspaceAction: HandoffWorkspaceActionV1Schema.optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.targetDirectory?.kind === 'managed' && !value.operationId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operationId'], message: 'Managed handoff requires operation identity' });
    }
  })
  .superRefine(rejectLegacyInlineTransferFields)
  .superRefine(refineSessionHandoffStateTransferV3)
  .superRefine(rejectRetiredWorkspaceActionFields));
export type SessionHandoffStartRequest = z.infer<typeof SessionHandoffStartRequestSchema>;

const SessionHandoffPrepareTargetFieldsSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    sourceMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    targetMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    operationId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    sessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    targetDirectory: z.object({ kind: z.literal('managed') }).strict().optional(),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema,
    allowServerRoutedFallback: z.boolean().optional(),
    sourceSessionStorageMode: SessionHandoffStorageModeSchema,
    stateTransfer: SessionHandoffStateTransferSchema.optional(),
    targetSessionStorageMode: SessionHandoffStorageModeSchema.optional(),
    targetPath: z.string().max(MAX_PATH_LENGTH).default(''),
    /** Repository materialization root for a git_worktree handoff. */
    workspaceRootPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    /** Safe repository-relative cwd; empty means the repository root. */
    workspaceSessionRelativeCwd: z.string().max(MAX_PATH_LENGTH).optional(),
    endpointCandidates: z
      .array(TransferEndpointCandidateSchema)
      .readonly()
      .default(() => []),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
    workspaceAction: HandoffWorkspaceActionV1Schema.optional(),
  }));

function refineSessionHandoffPrepareTargetRequest(
  value: z.infer<typeof SessionHandoffPrepareTargetFieldsSchema>, context: z.RefinementCtx,
): void {
    refineSessionHandoffStateTransferV3(value, context);
    if (value.stateTransfer === 'existing' && !value.sessionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionId'], message: 'Existing session state requires exact Session identity' });
    }
    if (value.targetDirectory?.kind === 'managed') {
      for (const field of ['operationId', 'sessionId'] as const) {
        if (!value[field]) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Managed handoff requires target allocation identity' });
      }
      if (value.workspaceAction && value.workspaceAction.kind !== 'none') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceAction'], message: 'Managed handoff cannot enroll workspace relationships' });
      }
    } else if (!value.targetPath.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetPath'], message: 'Path handoff requires a target path' });
    }
    if ((value.workspaceRootPath === undefined) !== (value.workspaceSessionRelativeCwd === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workspaceSessionRelativeCwd'],
        message: 'workspace root and session-relative cwd must be provided together',
      });
    }
}

export const SessionHandoffPrepareTargetRequestSchema = lazyZodSchema(() => SessionHandoffPrepareTargetFieldsSchema
  .passthrough()
  .superRefine(refineSessionHandoffPrepareTargetRequest)
  .superRefine(rejectLegacyInlineTransferFields)
  .superRefine(rejectRetiredWorkspaceActionFields));
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

/** Host-private credential transfer is closed and always names the existing Session. */
export const SessionHandoffPrepareTargetPrivateRequestV1Schema = lazyZodSchema(() => SessionHandoffPrepareTargetFieldsSchema
  .extend({ sessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH) })
  .strict()
  .superRefine(refineSessionHandoffPrepareTargetRequest)
  .superRefine(rejectLegacyInlineTransferFields)
  .superRefine(rejectRetiredWorkspaceActionFields));

export const SessionHandoffPrepareTargetResultGetRequestSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  })
  .strict());
export type SessionHandoffPrepareTargetResultGetRequest = z.infer<typeof SessionHandoffPrepareTargetResultGetRequestSchema>;

export const SessionHandoffPrepareTargetResumeRequestSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    jobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).regex(/^[A-Za-z0-9._-]+$/u),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    attemptId: z.string().min(1).max(MAX_ATTEMPT_ID_LENGTH),
  })
  .strict());
export type SessionHandoffPrepareTargetResumeRequest = z.infer<
  typeof SessionHandoffPrepareTargetResumeRequestSchema
>;

export const SessionHandoffCommitRequestSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    mode: z.enum(['target', 'source_cleanup']).optional(),
  })
  .strict());
export type SessionHandoffCommitRequest = z.infer<typeof SessionHandoffCommitRequestSchema>;

export const SessionHandoffAbortRequestSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    reason: z.string().min(1).max(1024),
  })
  .strict());
export type SessionHandoffAbortRequest = z.infer<typeof SessionHandoffAbortRequestSchema>;

export const SessionHandoffStartResponseSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    endpointCandidates: z
      .array(TransferEndpointCandidateSchema)
      .readonly()
      .default(() => []),
    targetPath: z.string().min(1).max(MAX_PATH_LENGTH),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields));
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

/**
 * The single public terminal result of the `session.handoff` Action. Transport
 * and coordinator success envelopes stay behind their owning adapters; Action
 * callers receive the committed handoff state and any bounded recovery facts.
 */
export const SessionHandoffActionResultV1Schema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    workspace: HandoffWorkspaceOutcomeV1Schema,
    warning: z
      .object({
        code: z.string().trim().min(1).max(128),
        message: z.string().trim().min(1).max(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH),
      })
      .strict()
      .optional(),
  })
  .strict());
export type SessionHandoffActionResultV1 = z.infer<typeof SessionHandoffActionResultV1Schema>;

export const SessionHandoffPrepareTargetResponseSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: NonBlankOpaqueIdentifierSchema.max(MAX_HANDOFF_ID_LENGTH).optional(),
    directSource: ExternalSessionsSourceSchema.optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema.optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields));
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

export const SessionHandoffPrepareTargetResultGetSuccessResponseSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: NonBlankOpaqueIdentifierSchema.max(MAX_HANDOFF_ID_LENGTH),
    directSource: ExternalSessionsSourceSchema,
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema,
  })
  .passthrough());
export type SessionHandoffPrepareTargetResultGetSuccessResponse = z.infer<
  typeof SessionHandoffPrepareTargetResultGetSuccessResponseSchema
>;

const SessionHandoffPrepareTargetResultGetFailureResponseSchema = lazyZodSchema(() => z.discriminatedUnion('errorCode', [
  z.object({
    ok: z.literal(false),
    errorCode: z.enum([
      'invalid_request',
      'not_found',
    ]),
  }).strict(),
  z.object({
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
      .string()
      .min(1)
      .max(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: SessionHandoffPrepareTargetFailureCodeSchema,
    error: z
      .string()
      .min(1)
      .max(SESSION_HANDOFF_PREPARE_TARGET_FAILURE_MESSAGE_MAX_LENGTH),
  }).strict(),
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
  z.object({
    ok: z.literal(true),
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    jobId: z.string().min(1).max(MAX_JOB_ID_LENGTH),
    transitionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: SessionHandoffStatusSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: SessionHandoffPrepareTargetResumeErrorCodeSchema,
      message: z.string().min(1).max(2_000),
    }).strict(),
  }).strict(),
]));
export type SessionHandoffPrepareTargetResumeResponse = z.infer<
  typeof SessionHandoffPrepareTargetResumeResponseSchema
>;

export const SessionHandoffCommitResponseSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
  })
  .strict());
export type SessionHandoffCommitResponse = z.infer<typeof SessionHandoffCommitResponseSchema>;

export const SessionHandoffAbortResponseSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
  })
  .strict());
export type SessionHandoffAbortResponse = z.infer<typeof SessionHandoffAbortResponseSchema>;

export const SessionHandoffStatusGetRequestSchema = lazyZodSchema(() => z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  })
  .passthrough());
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
