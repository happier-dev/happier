import { z } from 'zod';
import {
  ExternalSessionAgentIdSchema,
  ExternalSessionsSourceSchema,
} from '../../external/sourceCatalog.js';
import { RuntimeDescriptorV1Schema } from '../../metadata/runtimeDescriptorV1.js';

import {
  SessionHandoffCodexAffinitySchema,
  SessionHandoffCodexBackendModeSchema,
  SessionHandoffConflictPolicySchema,
  SessionHandoffStorageModeSchema,
  SessionHandoffTransportStrategySchema,
  SessionHandoffWorkspaceTransferStrategySchema,
} from './handoffTypes.js';
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
const MAX_ENDPOINT_CANDIDATES = 20;
const MAX_PREFERRED_TRANSPORT_STRATEGIES = 4;
const MAX_INCLUDE_GLOBS = 128;
const MAX_SOURCE_CONTROLLER_METADATA_KEYS = 50;
const MAX_SOURCE_CONTROLLER_METADATA_JSON_BYTES = 32 * 1024;
const MAX_ATTEMPT_ID_LENGTH = 256;

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

export const SessionHandoffWorkspaceTransferSchema = z
  .object({
    enabled: z.boolean(),
    strategy: SessionHandoffWorkspaceTransferStrategySchema.default('transfer_snapshot'),
    conflictPolicy: SessionHandoffConflictPolicySchema,
    includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
    ignoredIncludeGlobs: z.array(z.string().min(1).max(512)).max(MAX_INCLUDE_GLOBS).readonly().default(() => []),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.strategy === 'sync_changes' && value.conflictPolicy === 'create_sibling_copy') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conflictPolicy'],
        message: 'conflictPolicy=create_sibling_copy is not supported for workspaceTransfer.strategy=sync_changes',
      });
    }
  });
export type SessionHandoffWorkspaceTransfer = z.infer<typeof SessionHandoffWorkspaceTransferSchema>;

const SessionHandoffAgentBundleTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1).max(MAX_TRANSFER_ID_LENGTH),
    sizeBytes: z.number().int().min(0),
    manifestHash: z.string().min(1).max(MAX_MANIFEST_HASH_LENGTH),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).max(MAX_ENDPOINT_CANDIDATES).readonly().optional(),
  })
  .passthrough();
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

const SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1).max(MAX_TRANSFER_ID_LENGTH),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).max(MAX_ENDPOINT_CANDIDATES).readonly().optional(),
  })
  .passthrough();
export type SessionHandoffWorkspaceReplicationManifestTransferPublication = z.infer<
  typeof SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema
>;

export const SessionHandoffMetadataV2Schema = z
  .object({
    agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublicationSchema.optional(),
    // Prospective remote-dev persisted prepare-target records used the Provider-era field.
    // Remove this reader only after no supported predecessor produces it and retained jobs are reconciled.
    providerBundleTransferPublication: SessionHandoffAgentBundleTransferPublicationSchema.optional(),
    workspaceReplicationSourceRootPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    // When a session is being handed back to its prior source machine using `sync_changes`, the
    // source daemon can surface the original source-machine workspace root so clients do not need
    // to rely on hydrated UI state to select the correct target directory.
    workspaceReplicationHandoffBackTargetRootPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    workspaceReplicationManifestTransferPublication: SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema.optional(),
    workspaceReplicationSourceControllerMetadata: z
      .record(z.string().min(1).max(128), z.unknown())
      .superRefine((value, context) => {
        const entries = Object.keys(value);
        if (entries.length > MAX_SOURCE_CONTROLLER_METADATA_KEYS) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'workspaceReplicationSourceControllerMetadata is too large',
          });
        }
        let json: string;
        try {
          json = JSON.stringify(value);
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'workspaceReplicationSourceControllerMetadata is too large',
          });
          return;
        }
        const byteLength = new TextEncoder().encode(json).length;
        if (byteLength > MAX_SOURCE_CONTROLLER_METADATA_JSON_BYTES) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'workspaceReplicationSourceControllerMetadata is too large',
          });
        }
      })
      .optional(),
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
  });
export type SessionHandoffMetadataV2 = z.infer<typeof SessionHandoffMetadataV2Schema>;

const SessionHandoffResumePlanSchema = z
  .object({
    directory: z.string().min(1).max(MAX_PATH_LENGTH),
    agent: ExternalSessionAgentIdSchema,
    resume: z.string().min(1).max(4096),
    environmentVariables: z.record(z.string().min(1).max(128), z.string().max(16 * 1024)).optional(),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
    codexBackendMode: SessionHandoffCodexBackendModeSchema.optional(),
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
  });
export type SessionHandoffResumePlan = z.infer<typeof SessionHandoffResumePlanSchema>;

export const SessionHandoffStartRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    sourceMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    targetMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    sessionStorageMode: SessionHandoffStorageModeSchema,
    preferredTransportStrategies: z
      .array(SessionHandoffTransportStrategySchema)
      .min(1)
      .max(MAX_PREFERRED_TRANSPORT_STRATEGIES)
      .readonly(),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema.optional(),
    workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields);
export type SessionHandoffStartRequest = z.infer<typeof SessionHandoffStartRequestSchema>;

export const SessionHandoffPrepareTargetRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    sourceMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    targetMachineId: z.string().min(1).max(MAX_MACHINE_ID_LENGTH),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema,
    allowServerRoutedFallback: z.boolean().optional(),
    sourceSessionStorageMode: SessionHandoffStorageModeSchema,
    targetSessionStorageMode: SessionHandoffStorageModeSchema.optional(),
    targetPath: z.string().min(1).max(MAX_PATH_LENGTH),
    endpointCandidates: z
      .array(TransferEndpointCandidateSchema)
      .max(MAX_ENDPOINT_CANDIDATES)
      .readonly()
      .default(() => []),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
    workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields);
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

export const SessionHandoffPrepareTargetResultGetRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  })
  .strict();
export type SessionHandoffPrepareTargetResultGetRequest = z.infer<typeof SessionHandoffPrepareTargetResultGetRequestSchema>;

export const SessionHandoffPrepareTargetResumeRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    jobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).regex(/^[A-Za-z0-9._-]+$/u),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    attemptId: z.string().min(1).max(MAX_ATTEMPT_ID_LENGTH),
  })
  .strict();
export type SessionHandoffPrepareTargetResumeRequest = z.infer<
  typeof SessionHandoffPrepareTargetResumeRequestSchema
>;

export const SessionHandoffCommitRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    mode: z.enum(['target', 'source_cleanup']).optional(),
    workspaceReplicationReverseSourceRootPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    workspaceReplicationReverseTargetRootPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  })
  .strict();
export type SessionHandoffCommitRequest = z.infer<typeof SessionHandoffCommitRequestSchema>;

export const SessionHandoffAbortRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    reason: z.string().min(1).max(1024),
  })
  .strict();
export type SessionHandoffAbortRequest = z.infer<typeof SessionHandoffAbortRequestSchema>;

export const SessionHandoffStartResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    endpointCandidates: z
      .array(TransferEndpointCandidateSchema)
      .max(MAX_ENDPOINT_CANDIDATES)
      .readonly()
      .default(() => []),
    targetPath: z.string().min(1).max(MAX_PATH_LENGTH),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields);
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

export const SessionHandoffPrepareTargetResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    directSource: ExternalSessionsSourceSchema.optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema.optional(),
    workspaceReplicationJobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).optional(),
  })
  .passthrough()
  .superRefine(rejectLegacyInlineTransferFields);
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

export const SessionHandoffPrepareTargetResultGetSuccessResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    directSource: ExternalSessionsSourceSchema,
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema,
    workspaceReplicationJobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).optional(),
  })
  .passthrough();
export type SessionHandoffPrepareTargetResultGetSuccessResponse = z.infer<
  typeof SessionHandoffPrepareTargetResultGetSuccessResponseSchema
>;

const SessionHandoffPrepareTargetResultGetFailureResponseSchema = z.discriminatedUnion('errorCode', [
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
]);

export const SessionHandoffPrepareTargetResultGetResponseSchema = z.union([
  SessionHandoffPrepareTargetResultGetSuccessResponseSchema,
  SessionHandoffPrepareTargetResultGetFailureResponseSchema,
]);
export type SessionHandoffPrepareTargetResultGetResponse = z.infer<typeof SessionHandoffPrepareTargetResultGetResponseSchema>;

export const SessionHandoffPrepareTargetResumeErrorCodeSchema = z.enum([
  'invalid_request',
  'not_found',
  'identity_conflict',
  'stale_revision',
  'attempt_conflict',
  'invalid_state',
  'reconciliation_required',
  'internal_error',
]);
export type SessionHandoffPrepareTargetResumeErrorCode = z.infer<
  typeof SessionHandoffPrepareTargetResumeErrorCodeSchema
>;

export const SessionHandoffPrepareTargetResumeResponseSchema = z.discriminatedUnion('ok', [
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
]);
export type SessionHandoffPrepareTargetResumeResponse = z.infer<
  typeof SessionHandoffPrepareTargetResumeResponseSchema
>;

export const SessionHandoffCommitResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
  })
  .strict();
export type SessionHandoffCommitResponse = z.infer<typeof SessionHandoffCommitResponseSchema>;

export const SessionHandoffAbortResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
  })
  .strict();
export type SessionHandoffAbortResponse = z.infer<typeof SessionHandoffAbortResponseSchema>;

export const SessionHandoffStatusGetRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  })
  .passthrough();
export type SessionHandoffStatusGetRequest = z.infer<typeof SessionHandoffStatusGetRequestSchema>;

export {
  SessionHandoffProgressCheckpointSchema,
  SessionHandoffPrepareTargetFailureCodeSchema,
  SessionHandoffPrepareTargetFailureSchema,
  SessionHandoffProgressWarningCodeSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspacePreflightSummarySchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
};
