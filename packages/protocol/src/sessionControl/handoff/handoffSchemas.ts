import { z } from 'zod';
import { DirectSessionsSourceSchema } from '../../directSessions/daemonRpcV1.js';
import { AgentRuntimeDescriptorV1Schema } from '../../sessionMetadata/agentRuntimeDescriptorV1.js';
import { WorkspaceManifestSchema } from '../../workspaces/manifestSchema.js';

import {
  SessionHandoffCodexAffinitySchema,
  SessionHandoffCodexBackendModeSchema,
  SessionHandoffConflictPolicySchema,
  SessionHandoffStorageModeSchema,
  SessionHandoffTransportStrategySchema,
  SessionHandoffWorkspaceTransferStrategySchema,
} from './handoffTypes.js';
import { SessionHandoffStatusSchema } from './handoffStatus.js';
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

export const SessionHandoffTransferredWorkspaceArtifactsSchema = z
  .object({
    manifest: WorkspaceManifestSchema,
    blobs: z.array(z.object({
      digest: z.string().min(1),
      contentBase64: z.string(),
    }).strict()),
    sourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SessionHandoffTransferredWorkspaceArtifacts = z.infer<
  typeof SessionHandoffTransferredWorkspaceArtifactsSchema
>;

export const SessionHandoffWorkspaceBundleEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    contentBase64: z.string().min(1),
  })
  .strict();
export type SessionHandoffWorkspaceBundleEntry = z.infer<
  typeof SessionHandoffWorkspaceBundleEntrySchema
>;

export const SessionHandoffWorkspaceBundleSchema = z
  .object({
    entries: z.array(SessionHandoffWorkspaceBundleEntrySchema),
  })
  .strict();
export type SessionHandoffWorkspaceBundle = z.infer<typeof SessionHandoffWorkspaceBundleSchema>;

const SESSION_HANDOFF_CODEX_BACKEND_MODES = ['mcp', 'acp', 'appServer'] as const;

function normalizeLegacyCodexResumeTransport(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  const codexBackendMode = candidate.codexBackendMode;
  const hasCanonicalCodexBackendMode =
    typeof codexBackendMode === 'string'
    && (SESSION_HANDOFF_CODEX_BACKEND_MODES as readonly string[]).includes(codexBackendMode);
  if (!hasCanonicalCodexBackendMode && candidate.experimentalCodexAcp !== true) {
    return value;
  }

  const { experimentalCodexAcp: _legacyExperimentalCodexAcp, ...rest } = candidate;
  return hasCanonicalCodexBackendMode
    ? rest
    : {
        ...rest,
        codexBackendMode: 'acp',
      };
}

function normalizeLegacyCodexProviderBundle(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.providerId !== 'codex') {
    return value;
  }

  const codexBackendMode = candidate.codexBackendMode;
  const normalizedBackendMode =
    typeof codexBackendMode === 'string'
    && (SESSION_HANDOFF_CODEX_BACKEND_MODES as readonly string[]).includes(codexBackendMode)
      ? codexBackendMode
      : null;
  if (!normalizedBackendMode) {
    return value;
  }

  const { codexBackendMode: _legacyCodexBackendMode, affinity, ...rest } = candidate;
  if (affinity && typeof affinity === 'object' && !Array.isArray(affinity)) {
    return {
      ...rest,
      affinity,
    };
  }

  return {
    ...rest,
    affinity: {
      backendMode: normalizedBackendMode,
    },
  };
}

const SessionHandoffResumePlanSchema = z.preprocess(
  normalizeLegacyCodexResumeTransport,
  z
  .object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'opencode']),
    resume: z.string().min(1),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    transcriptStorage: z.enum(['direct', 'persisted']),
    approvedNewDirectoryCreation: z.literal(true),
    codexBackendMode: SessionHandoffCodexBackendModeSchema.optional(),
  })
  .strict(),
);
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

export const SessionHandoffProviderBundleSchema = z.preprocess(
  normalizeLegacyCodexProviderBundle,
  z.discriminatedUnion('providerId', [
    ClaudeSessionHandoffBundleSchema,
    CodexSessionHandoffBundleSchema,
    OpenCodeSessionHandoffBundleSchema,
  ]),
);
export type SessionHandoffProviderBundle =
  | ClaudeSessionHandoffBundle
  | CodexSessionHandoffBundle
  | OpenCodeSessionHandoffBundle;

function stripLegacyWorkspaceManifestHash(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.workspaceManifestHash === undefined) {
    return value;
  }

  const { workspaceManifestHash: _legacyWorkspaceManifestHash, ...canonicalPayload } = candidate;
  return canonicalPayload;
}

function stripLegacyTransferredPayloadFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  const {
    transferredPayload: _legacyTransferredPayload,
    providerBundle: _legacyProviderBundle,
    workspaceArtifacts: _legacyWorkspaceArtifacts,
    ...rest
  } = candidate;
  return rest;
}

export const SessionHandoffTransferredPayloadSchema = z
  .object({
    providerBundle: SessionHandoffProviderBundleSchema,
    workspaceArtifacts: SessionHandoffTransferredWorkspaceArtifactsSchema.optional(),
  })
  .strict();
export type SessionHandoffTransferredPayload = Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  workspaceArtifacts?: SessionHandoffTransferredWorkspaceArtifacts;
}>;

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

export const SessionHandoffPrepareTargetRequestSchema = z.preprocess(
  (value) => stripLegacyTransferredPayloadFields(stripLegacyWorkspaceManifestHash(value)),
  z
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
      workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
    })
    .strict(),
);
export type SessionHandoffPrepareTargetRequest = z.infer<typeof SessionHandoffPrepareTargetRequestSchema>;

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
  .preprocess(
    stripLegacyTransferredPayloadFields,
    z
      .object({
        handoffId: z.string().min(1),
        status: SessionHandoffStatusSchema,
        endpointCandidates: z.array(TransferEndpointCandidateSchema).default([]),
        targetPath: z.string().min(1),
      })
      .strict(),
  );
export type SessionHandoffStartResponse = z.infer<typeof SessionHandoffStartResponseSchema>;

export const SessionHandoffPrepareTargetResponseSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusSchema,
    remoteSessionId: z.string().min(1),
    directSource: DirectSessionsSourceSchema,
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    resume: SessionHandoffResumePlanSchema,
  })
  .strict();
export type SessionHandoffPrepareTargetResponse = z.infer<typeof SessionHandoffPrepareTargetResponseSchema>;

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
  SessionHandoffStatusSchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
};
