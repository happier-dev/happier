import { z } from 'zod';
import { DirectSessionsSourceSchema } from '../../directSessions/daemonRpcV1.js';
import { AgentProviderIdV1Schema } from '../../providers/agentProviderIdsV1.js';
import { AgentRuntimeDescriptorV1Schema } from '../../sessionMetadata/agentRuntimeDescriptorV1.js';

import {
  SessionHandoffCodexAffinitySchema,
  SessionHandoffCodexBackendModeSchema,
  SessionHandoffConflictPolicySchema,
  SessionHandoffStorageModeSchema,
  SessionHandoffTransportStrategySchema,
  SessionHandoffWorkspaceTransferStrategySchema,
} from './handoffTypes.js';
import {
  SessionHandoffProgressCheckpointSchema,
  SessionHandoffProgressWarningCodeSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspacePreflightSummarySchema,
} from './handoffStatus.js';
import { TransferChunkEnvelopeSchema, TransferEndpointCandidateSchema } from '../../machineTransfer/transferStream.js';

const MAX_HANDOFF_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_TRANSFER_ID_LENGTH = 512;
const MAX_MANIFEST_HASH_LENGTH = 256;
const MAX_ENDPOINT_CANDIDATES = 20;
const MAX_PREFERRED_TRANSPORT_STRATEGIES = 4;
const MAX_INCLUDE_GLOBS = 128;
const MAX_SOURCE_CONTROLLER_METADATA_KEYS = 50;
const MAX_SOURCE_CONTROLLER_METADATA_JSON_BYTES = 32 * 1024;

export const SessionHandoffWorkspaceTransferSchema = z
  .object({
    enabled: z.boolean(),
    strategy: SessionHandoffWorkspaceTransferStrategySchema.default('transfer_snapshot'),
    conflictPolicy: SessionHandoffConflictPolicySchema,
    includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
    ignoredIncludeGlobs: z.array(z.string().min(1).max(512)).max(MAX_INCLUDE_GLOBS).readonly().default(() => []),
  })
  .strict()
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

const SessionHandoffProviderBundleTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1).max(MAX_TRANSFER_ID_LENGTH),
    sizeBytes: z.number().int().min(0),
    manifestHash: z.string().min(1).max(MAX_MANIFEST_HASH_LENGTH),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).max(MAX_ENDPOINT_CANDIDATES).readonly().optional(),
  })
  .strict();
export type SessionHandoffProviderBundleTransferPublication = z.infer<
  typeof SessionHandoffProviderBundleTransferPublicationSchema
>;

const SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1).max(MAX_TRANSFER_ID_LENGTH),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).max(MAX_ENDPOINT_CANDIDATES).readonly().optional(),
  })
  .strict();
export type SessionHandoffWorkspaceReplicationManifestTransferPublication = z.infer<
  typeof SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema
>;

export const SessionHandoffMetadataV2Schema = z
  .object({
    providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublicationSchema.optional(),
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
  .strict();
export type SessionHandoffMetadataV2 = z.infer<typeof SessionHandoffMetadataV2Schema>;

const SessionHandoffResumePlanSchema = z
  .object({
    directory: z.string().min(1).max(MAX_PATH_LENGTH),
    agent: AgentProviderIdV1Schema,
    resume: z.string().min(1).max(4096),
    environmentVariables: z.record(z.string().min(1).max(128), z.string().max(16 * 1024)).optional(),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
    codexBackendMode: SessionHandoffCodexBackendModeSchema.optional(),
  })
  .strict();
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
  .strict();
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
  .strict();
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

export const SessionHandoffPrepareTargetResultGetRequestSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
  })
  .strict();
export type SessionHandoffPrepareTargetResultGetRequest = z.infer<typeof SessionHandoffPrepareTargetResultGetRequestSchema>;

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
  .strict();
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

export const SessionHandoffPrepareTargetResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH).optional(),
    directSource: DirectSessionsSourceSchema.optional(),
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema.optional(),
  })
  .strict();
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

export const SessionHandoffPrepareTargetResultGetResponseSchema = z
  .object({
    handoffId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1).max(MAX_HANDOFF_ID_LENGTH),
    directSource: DirectSessionsSourceSchema,
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema,
  })
  .strict();
export type SessionHandoffPrepareTargetResultGetResponse = z.infer<typeof SessionHandoffPrepareTargetResultGetResponseSchema>;

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
  .strict();
export type SessionHandoffStatusGetRequest = z.infer<typeof SessionHandoffStatusGetRequestSchema>;

export {
  SessionHandoffProgressCheckpointSchema,
  SessionHandoffProgressWarningCodeSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspacePreflightSummarySchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
};
