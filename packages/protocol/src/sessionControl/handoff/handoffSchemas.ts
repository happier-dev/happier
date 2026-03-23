import { z } from 'zod';
import { DirectSessionsSourceSchema } from '../../directSessions/daemonRpcV1.js';
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
import { TransferChunkEnvelopeSchema, TransferEndpointCandidateSchema } from './transferStream.js';

export const SessionHandoffWorkspaceTransferSchema = z
  .object({
    enabled: z.boolean(),
    strategy: SessionHandoffWorkspaceTransferStrategySchema.default('transfer_snapshot'),
    conflictPolicy: SessionHandoffConflictPolicySchema,
    includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
    ignoredIncludeGlobs: z.array(z.string()).default([]),
  })
  .strict();
export type SessionHandoffWorkspaceTransfer = z.infer<typeof SessionHandoffWorkspaceTransferSchema>;

const SessionHandoffProviderBundleTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1),
    sizeBytes: z.number().int().min(0),
    manifestHash: z.string().min(1),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).optional(),
  })
  .strict();

const SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema = z
  .object({
    transferId: z.string().min(1),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).optional(),
  })
  .strict();

export const SessionHandoffMetadataV2Schema = z
  .object({
    providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublicationSchema.optional(),
    workspaceReplicationSourceRootPath: z.string().min(1).optional(),
    workspaceReplicationManifestTransferPublication: SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema.optional(),
    workspaceReplicationSourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SessionHandoffMetadataV2 = z.infer<typeof SessionHandoffMetadataV2Schema>;

const SessionHandoffResumePlanSchema = z
  .object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'opencode']),
    resume: z.string().min(1),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
    codexBackendMode: SessionHandoffCodexBackendModeSchema.optional(),
  })
  .strict();
export type SessionHandoffResumePlan = z.infer<typeof SessionHandoffResumePlanSchema>;

const ClaudeSessionHandoffBundleSchema = z
  .object({
    providerId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.string().min(1),
  })
  .strict();

const CodexSessionHandoffBundleSchema = z
  .object({
    providerId: z.literal('codex'),
    remoteSessionId: z.string().min(1),
    affinity: SessionHandoffCodexAffinitySchema.optional(),
    files: z.array(
      z
        .object({
          relativePath: z.string().min(1),
          contentBase64: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const OpenCodeSessionHandoffBundleSchema = z
  .object({
    providerId: z.literal('opencode'),
    remoteSessionId: z.string().min(1),
    exportJsonBase64: z.string().min(1),
    affinity: z
      .object({
        backendMode: z.enum(['server', 'acp']).nullable(),
        serverBaseUrl: z.string().nullable(),
        serverBaseUrlExplicit: z.boolean(),
      })
      .strict(),
  })
  .strict();

type ClaudeSessionHandoffBundle = Readonly<{
  providerId: 'claude';
  remoteSessionId: string;
  transcriptBase64: string;
}>;
type CodexSessionHandoffBundle = Readonly<{
  providerId: 'codex';
  remoteSessionId: string;
  affinity?: z.infer<typeof SessionHandoffCodexAffinitySchema>;
  files: readonly Readonly<{
    relativePath: string;
    contentBase64: string;
  }>[];
}>;
type OpenCodeSessionHandoffBundle = Readonly<{
  providerId: 'opencode';
  remoteSessionId: string;
  exportJsonBase64: string;
  affinity: Readonly<{
    backendMode: 'server' | 'acp' | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
}>;

export const SessionHandoffProviderBundleSchema = z.discriminatedUnion('providerId', [
  ClaudeSessionHandoffBundleSchema,
  CodexSessionHandoffBundleSchema,
  OpenCodeSessionHandoffBundleSchema,
]);
export type SessionHandoffProviderBundle =
  | ClaudeSessionHandoffBundle
  | CodexSessionHandoffBundle
  | OpenCodeSessionHandoffBundle;

export const SessionHandoffStartRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    sessionStorageMode: SessionHandoffStorageModeSchema,
    preferredTransportStrategies: z.array(SessionHandoffTransportStrategySchema).min(1),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema.optional(),
    workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
  })
  .strict();
export type SessionHandoffStartRequest = z.infer<typeof SessionHandoffStartRequestSchema>;

export const SessionHandoffPrepareTargetRequestSchema = z
  .object({
    handoffId: z.string().min(1),
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    negotiatedTransportStrategy: SessionHandoffTransportStrategySchema,
    allowServerRoutedFallback: z.boolean().optional(),
    sourceSessionStorageMode: SessionHandoffStorageModeSchema,
    targetSessionStorageMode: SessionHandoffStorageModeSchema.optional(),
    targetPath: z.string().min(1),
    endpointCandidates: z.array(TransferEndpointCandidateSchema).default([]),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
    workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
  })
  .strict();
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

export const SessionHandoffPrepareTargetResultGetRequestSchema = z
  .object({
    handoffId: z.string().min(1),
  })
  .strict();
export type SessionHandoffPrepareTargetResultGetRequest = z.infer<typeof SessionHandoffPrepareTargetResultGetRequestSchema>;

export const SessionHandoffCommitRequestSchema = z
  .object({
    handoffId: z.string().min(1),
  })
  .strict();
export type SessionHandoffCommitRequest = z.infer<typeof SessionHandoffCommitRequestSchema>;

export const SessionHandoffAbortRequestSchema = z
  .object({
    handoffId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type SessionHandoffAbortRequest = z.infer<typeof SessionHandoffAbortRequestSchema>;

export const SessionHandoffStartResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
    endpointCandidates: z.array(TransferEndpointCandidateSchema).default([]),
    targetPath: z.string().min(1),
    handoffMetadataV2: SessionHandoffMetadataV2Schema.optional(),
  })
  .strict();
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

export const SessionHandoffPrepareTargetResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1).optional(),
    directSource: DirectSessionsSourceSchema.optional(),
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema.optional(),
  })
  .strict();
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

export const SessionHandoffPrepareTargetResultGetResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1),
    directSource: DirectSessionsSourceSchema,
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema,
  })
  .strict();
export type SessionHandoffPrepareTargetResultGetResponse = z.infer<typeof SessionHandoffPrepareTargetResultGetResponseSchema>;

export const SessionHandoffCommitResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
  })
  .strict();
export type SessionHandoffCommitResponse = z.infer<typeof SessionHandoffCommitResponseSchema>;

export const SessionHandoffAbortResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
  })
  .strict();
export type SessionHandoffAbortResponse = z.infer<typeof SessionHandoffAbortResponseSchema>;

export const SessionHandoffStatusGetRequestSchema = z
  .object({
    handoffId: z.string().min(1),
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
