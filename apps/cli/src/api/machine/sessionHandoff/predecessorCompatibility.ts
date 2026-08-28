import { randomUUID } from 'node:crypto';

import {
  ConnectedServiceBindingsV1Schema,
  normalizeCodexBackendMode,
  projectRuntimeDescriptorV1ForPredecessor,
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetResponseSchema,
  SessionHandoffStartResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { z } from 'zod';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import type {
  SessionHandoffPrepareTargetJobRecordV2,
  SessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '../../../session/shared/spawnSessionContract';

type JsonRecord = Record<string, unknown>;

// Immutable request vectors from cli-v0.2.1. These schemas deliberately live
// at the released compatibility seam: current Protocol handoff schemas are
// additive/passthrough and therefore cannot freeze the unversioned methods.
const RELEASED_HANDOFF_ID_MAX = 256;
const RELEASED_MACHINE_ID_MAX = 256;
const RELEASED_PATH_MAX = 4096;
const RELEASED_ENDPOINT_URL_MAX = 2048;
const RELEASED_ENDPOINT_TOKEN_MAX = 2048;
const RELEASED_ENDPOINTS_MAX = 20;
const RELEASED_TRANSFER_ID_MAX = 512;
const RELEASED_MANIFEST_HASH_MAX = 256;
const RELEASED_INCLUDE_GLOBS_MAX = 128;
const RELEASED_METADATA_KEYS_MAX = 50;
const RELEASED_METADATA_BYTES_MAX = 32 * 1024;

const ReleasedEndpointCandidateSchema = z.object({
  kind: z.enum(['tcp', 'http', 'https']),
  url: z.string().min(1).max(RELEASED_ENDPOINT_URL_MAX),
  authorizationToken: z.string().min(1).max(RELEASED_ENDPOINT_TOKEN_MAX).optional(),
  expiresAt: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  try {
    if (new URL(value.url).protocol !== `${value.kind}:`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `Transfer endpoint candidate URL must use the ${value.kind}: scheme`,
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'Transfer endpoint candidates need an absolute URL',
    });
  }
});

const ReleasedWorkspaceTransferSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(['transfer_snapshot', 'sync_changes']).default('transfer_snapshot'),
  conflictPolicy: z.enum(['create_sibling_copy', 'replace_existing']),
  includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
  ignoredIncludeGlobs: z.array(z.string().min(1).max(512))
    .max(RELEASED_INCLUDE_GLOBS_MAX).readonly().default(() => []),
}).strict().superRefine((value, context) => {
  if (value.strategy === 'sync_changes' && value.conflictPolicy === 'create_sibling_copy') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conflictPolicy'],
      message: 'conflictPolicy=create_sibling_copy is not supported for workspaceTransfer.strategy=sync_changes',
    });
  }
});

const ReleasedBundlePublicationSchema = z.object({
  transferId: z.string().min(1).max(RELEASED_TRANSFER_ID_MAX),
  sizeBytes: z.number().int().min(0),
  manifestHash: z.string().min(1).max(RELEASED_MANIFEST_HASH_MAX),
  endpointCandidates: z.array(ReleasedEndpointCandidateSchema).max(RELEASED_ENDPOINTS_MAX).readonly().optional(),
}).strict();

const ReleasedManifestPublicationSchema = z.object({
  transferId: z.string().min(1).max(RELEASED_TRANSFER_ID_MAX),
  endpointCandidates: z.array(ReleasedEndpointCandidateSchema).max(RELEASED_ENDPOINTS_MAX).readonly().optional(),
}).strict();

const ReleasedMetadataV2Schema = z.object({
  providerBundleTransferPublication: ReleasedBundlePublicationSchema.optional(),
  workspaceReplicationSourceRootPath: z.string().min(1).max(RELEASED_PATH_MAX).optional(),
  workspaceReplicationHandoffBackTargetRootPath: z.string().min(1).max(RELEASED_PATH_MAX).optional(),
  workspaceReplicationManifestTransferPublication: ReleasedManifestPublicationSchema.optional(),
  workspaceReplicationSourceControllerMetadata: z.record(z.string().min(1).max(128), z.unknown())
    .superRefine((value, context) => {
      if (Object.keys(value).length > RELEASED_METADATA_KEYS_MAX) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'workspaceReplicationSourceControllerMetadata is too large' });
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'workspaceReplicationSourceControllerMetadata is too large' });
        return;
      }
      if (new TextEncoder().encode(encoded).length > RELEASED_METADATA_BYTES_MAX) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'workspaceReplicationSourceControllerMetadata is too large' });
      }
    }).optional(),
}).strict();

const ReleasedStartRequestSchema = z.object({
  sessionId: z.string().min(1).max(RELEASED_HANDOFF_ID_MAX),
  sourceMachineId: z.string().min(1).max(RELEASED_MACHINE_ID_MAX),
  targetMachineId: z.string().min(1).max(RELEASED_MACHINE_ID_MAX),
  sessionStorageMode: z.enum(['direct', 'persisted']),
  preferredTransportStrategies: z.array(z.enum(['direct_peer', 'server_routed_stream']))
    .min(1).max(4).readonly(),
  negotiatedTransportStrategy: z.enum(['direct_peer', 'server_routed_stream']).optional(),
  workspaceTransfer: ReleasedWorkspaceTransferSchema.optional(),
}).strict();

const ReleasedPrepareTargetRequestSchema = z.object({
  handoffId: z.string().min(1).max(RELEASED_HANDOFF_ID_MAX),
  sourceMachineId: z.string().min(1).max(RELEASED_MACHINE_ID_MAX),
  targetMachineId: z.string().min(1).max(RELEASED_MACHINE_ID_MAX),
  negotiatedTransportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
  allowServerRoutedFallback: z.boolean().optional(),
  sourceSessionStorageMode: z.enum(['direct', 'persisted']),
  targetSessionStorageMode: z.enum(['direct', 'persisted']).optional(),
  targetPath: z.string().min(1).max(RELEASED_PATH_MAX),
  endpointCandidates: z.array(ReleasedEndpointCandidateSchema).max(RELEASED_ENDPOINTS_MAX).readonly().default(() => []),
  handoffMetadataV2: ReleasedMetadataV2Schema.optional(),
  workspaceTransfer: ReleasedWorkspaceTransferSchema.optional(),
}).strict();

const ReleasedResultGetRequestSchema = z.object({
  handoffId: z.string().min(1).max(RELEASED_HANDOFF_ID_MAX),
}).strict();

const ReleasedCommitRequestSchema = z.object({
  handoffId: z.string().min(1).max(RELEASED_HANDOFF_ID_MAX),
  mode: z.enum(['target', 'source_cleanup']).optional(),
  workspaceReplicationReverseSourceRootPath: z.string().min(1).max(RELEASED_PATH_MAX).optional(),
  workspaceReplicationReverseTargetRootPath: z.string().min(1).max(RELEASED_PATH_MAX).optional(),
}).strict();

const ReleasedAbortRequestSchema = z.object({
  handoffId: z.string().min(1).max(RELEASED_HANDOFF_ID_MAX),
  reason: z.string().min(1).max(1024),
}).strict();

const RELEASED_REQUEST_SCHEMA_BY_METHOD = Object.freeze({
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_START]: ReleasedStartRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET]: ReleasedPrepareTargetRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET]: ReleasedResultGetRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT]: ReleasedCommitRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT]: ReleasedAbortRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET]: ReleasedResultGetRequestSchema,
} satisfies Readonly<Record<string, z.ZodType>>);

export function projectReleasedSessionHandoffRequestForMethod(
  method: string,
  input: unknown,
): Readonly<
  | { accepted: true; input: unknown }
  | { accepted: false; response: Readonly<{ ok: false; errorCode: 'invalid_request' }> }
> {
  const schema = RELEASED_REQUEST_SCHEMA_BY_METHOD[method as keyof typeof RELEASED_REQUEST_SCHEMA_BY_METHOD];
  if (!schema) return { accepted: true, input };
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { accepted: true, input: parsed.data }
    : { accepted: false, response: { ok: false, errorCode: 'invalid_request' } };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function projectEndpointCandidate(value: unknown): unknown {
  const candidate = asRecord(value);
  if (!candidate) return value;
  return {
    kind: candidate.kind,
    url: candidate.url,
    ...(candidate.authorizationToken !== undefined
      ? { authorizationToken: candidate.authorizationToken }
      : {}),
    expiresAt: candidate.expiresAt,
  };
}

function projectProgress(value: unknown): unknown {
  const progress = asRecord(value);
  if (!progress) return value;
  const projectCounts = (raw: unknown): unknown => {
    const counts = asRecord(raw);
    if (!counts) return raw;
    return {
      ...(counts.files !== undefined ? { files: counts.files } : {}),
      ...(counts.bytes !== undefined ? { bytes: counts.bytes } : {}),
    };
  };
  const planned = asRecord(progress.planned);
  const transferred = asRecord(progress.transferred);
  const current = asRecord(progress.current);
  return {
    updatedAtMs: progress.updatedAtMs,
    checkpoint: progress.checkpoint,
    planned: {
      ...(planned?.totalFiles !== undefined ? { totalFiles: planned.totalFiles } : {}),
      ...(planned?.totalBytes !== undefined ? { totalBytes: planned.totalBytes } : {}),
      ...(planned?.added !== undefined ? { added: planned.added } : {}),
      ...(planned?.changed !== undefined ? { changed: planned.changed } : {}),
      ...(planned?.removed !== undefined ? { removed: planned.removed } : {}),
    },
    transferred: {
      ...(transferred?.files !== undefined ? { files: transferred.files } : {}),
      ...(transferred?.bytes !== undefined ? { bytes: transferred.bytes } : {}),
      ...(transferred?.blobs !== undefined ? { blobs: transferred.blobs } : {}),
    },
    ...(progress.applied !== undefined ? { applied: projectCounts(progress.applied) } : {}),
    ...(progress.remaining !== undefined ? { remaining: projectCounts(progress.remaining) } : {}),
    ...(current
      ? {
          current: {
            ...(current.relativePath !== undefined ? { relativePath: current.relativePath } : {}),
            ...(current.digest !== undefined ? { digest: current.digest } : {}),
            ...(current.phaseDetail !== undefined ? { phaseDetail: current.phaseDetail } : {}),
          },
        }
      : {}),
    resumable: progress.resumable,
    ...(progress.warnings !== undefined ? { warnings: progress.warnings } : {}),
  };
}

function projectStatus(value: unknown): unknown {
  const status = asRecord(value);
  if (!status) return value;
  const statusCode =
    status.status === 'awaiting_user_resume'
    || status.status === 'reconciliation_required'
      ? 'awaiting_recovery'
      : status.status;
  const transportStrategy =
    status.transportStrategy === 'direct_peer'
    || status.transportStrategy === 'server_routed_stream'
    || status.transportStrategy === null
      ? status.transportStrategy
      : undefined;
  const preflight = asRecord(status.workspacePreflightSummary);
  return {
    handoffId: status.handoffId,
    status: statusCode,
    phase: status.phase,
    ...(status.jobId !== undefined ? { jobId: status.jobId } : {}),
    ...(status.progress !== undefined ? { progress: projectProgress(status.progress) } : {}),
    ...(preflight
      ? {
          workspacePreflightSummary: {
            addedPathsCount: preflight.addedPathsCount,
            changedPathsCount: preflight.changedPathsCount,
            removedPathsCount: preflight.removedPathsCount,
            ...(preflight.totalBytes !== undefined ? { totalBytes: preflight.totalBytes } : {}),
          },
        }
      : {}),
    ...(transportStrategy !== undefined ? { transportStrategy } : {}),
    recoveryActions: status.recoveryActions,
  };
}

function projectPublication(value: unknown, includeSizeAndHash: boolean): unknown {
  const publication = asRecord(value);
  if (!publication) return value;
  return {
    transferId: publication.transferId,
    ...(includeSizeAndHash
      ? {
          sizeBytes: publication.sizeBytes,
          manifestHash: publication.manifestHash,
        }
      : {}),
    ...(Array.isArray(publication.endpointCandidates)
      ? { endpointCandidates: publication.endpointCandidates.map(projectEndpointCandidate) }
      : {}),
  };
}

function projectMetadata(value: unknown): unknown {
  const metadata = asRecord(value);
  if (!metadata) return value;
  const agentPublication =
    metadata.agentBundleTransferPublication
    ?? metadata.providerBundleTransferPublication;
  return {
    ...(agentPublication !== undefined
      ? {
          providerBundleTransferPublication: projectPublication(agentPublication, true),
        }
      : {}),
    ...(metadata.workspaceReplicationSourceRootPath !== undefined
      ? { workspaceReplicationSourceRootPath: metadata.workspaceReplicationSourceRootPath }
      : {}),
    ...(metadata.workspaceReplicationHandoffBackTargetRootPath !== undefined
      ? { workspaceReplicationHandoffBackTargetRootPath: metadata.workspaceReplicationHandoffBackTargetRootPath }
      : {}),
    ...(metadata.workspaceReplicationManifestTransferPublication !== undefined
      ? {
          workspaceReplicationManifestTransferPublication: projectPublication(
            metadata.workspaceReplicationManifestTransferPublication,
            false,
          ),
        }
      : {}),
    ...(metadata.workspaceReplicationSourceControllerMetadata !== undefined
      ? {
          workspaceReplicationSourceControllerMetadata:
            metadata.workspaceReplicationSourceControllerMetadata,
        }
      : {}),
  };
}

function projectResume(value: unknown, runtimeDescriptorV1?: unknown): unknown {
  const resume = asRecord(value);
  if (!resume) return value;
  const descriptor = asRecord(runtimeDescriptorV1);
  const descriptorAgent = asRecord(descriptor?.agent);
  const codexBackendMode = normalizeCodexBackendMode(
    resume.codexBackendMode
      ?? (descriptor?.agentId === 'codex' ? descriptorAgent?.backendMode : undefined),
  ) ?? undefined;
  return {
    directory: resume.directory,
    agent: resume.agent,
    resume: resume.resume,
    ...(resume.environmentVariables !== undefined
      ? { environmentVariables: resume.environmentVariables }
      : {}),
    transcriptStorage: resume.transcriptStorage,
    approvedNewDirectoryCreation: resume.approvedNewDirectoryCreation,
    ...(codexBackendMode ? { codexBackendMode } : {}),
  };
}

/**
 * Strict egress projection for preview/stable predecessor readers.
 *
 * Provenance: remote-dev 1b32cdc6 and immutable preview 4913c1e. The adapter may be removed only
 * after those deployed/rollback readers and V2 callers are unreachable.
 */
export function projectSessionHandoffStartResponseForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const response = SessionHandoffStartResponseSchema.parse(value);
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    endpointCandidates: response.endpointCandidates.map(projectEndpointCandidate),
    targetPath: response.targetPath,
    ...(response.handoffMetadataV2
      ? { handoffMetadataV2: projectMetadata(response.handoffMetadataV2) }
      : {}),
  };
}

export function projectSessionHandoffPrepareTargetResponseForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const response = SessionHandoffPrepareTargetResponseSchema.parse(value);
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    ...(response.remoteSessionId !== undefined
      ? { remoteSessionId: response.remoteSessionId }
      : {}),
    ...(response.directSource !== undefined ? { directSource: response.directSource } : {}),
    ...(response.runtimeDescriptorV1 !== undefined
      ? {
          agentRuntimeDescriptorV1:
            projectRuntimeDescriptorV1ForPredecessor(response.runtimeDescriptorV1),
        }
      : {}),
    ...(response.resume !== undefined
      ? { resume: projectResume(response.resume, response.runtimeDescriptorV1) }
      : {}),
  };
}

function projectStatusResponseForPredecessor(value: unknown): unknown {
  const response = asRecord(value);
  if (response?.ok === false || typeof response?.errorCode === 'string') {
    return value;
  }
  if (!response || typeof response.handoffId !== 'string' || !asRecord(response.status)) {
    return value;
  }
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    ...(response.targetCleanup !== undefined
      ? { targetCleanup: response.targetCleanup }
      : {}),
  };
}

/**
 * The six immutable released RPC spellings are the compatibility
 * discriminator. Current V3 methods never enter this projection.
 */
export function projectReleasedSessionHandoffResponseForMethod(
  method: string,
  value: unknown,
): unknown {
  if (method === RPC_METHODS.DAEMON_SESSION_HANDOFF_START) {
    return projectSessionHandoffResponseForPredecessor('start', value);
  }
  if (
    method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET
  ) {
    return projectSessionHandoffResponseForPredecessor('prepare', value);
  }
  if (
    method === RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET
  ) {
    return projectStatusResponseForPredecessor(value);
  }
  return value;
}

export function projectSessionHandoffResponseForPredecessor(
  kind: 'start' | 'prepare' | 'status',
  value: unknown,
): unknown {
  if (kind === 'start') {
    const parsed = SessionHandoffStartResponseSchema.safeParse(value);
    return parsed.success
      ? projectSessionHandoffStartResponseForPredecessor(parsed.data)
      : value;
  }
  if (kind === 'prepare') {
    const parsed = SessionHandoffPrepareTargetResponseSchema.safeParse(value);
    return parsed.success
      ? projectSessionHandoffPrepareTargetResponseForPredecessor(parsed.data)
      : value;
  }
  return projectStatusResponseForPredecessor(value);
}

const PredecessorPrepareTargetRequestV2Schema = z.object({
  handoffId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  sourceMachineId: z.string().min(1).max(256),
  targetMachineId: z.string().min(1).max(256),
  negotiatedTransportStrategy: z.unknown(),
  allowServerRoutedFallback: z.boolean().optional(),
  sourceSessionStorageMode: z.unknown(),
  targetSessionStorageMode: z.unknown().optional(),
  targetPath: z.string().min(1).max(4096),
  endpointCandidates: z.array(z.unknown()).max(20).default([]),
  handoffMetadataV2: z.unknown().optional(),
  workspaceTransfer: z.unknown().optional(),
}).strict();

const PredecessorResultGetRequestV2Schema = z.object({
  handoffId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
}).strict();

const PredecessorTargetResumeRequestV2Schema = z.object({
  handoffId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  attemptId: z.string().min(1).max(256),
  connectedServices: ConnectedServiceBindingsV1Schema.optional(),
}).strict();

const PredecessorTargetConfirmRequestV2Schema = z.object({
  handoffId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  attemptId: z.string().min(1).max(256),
}).strict();

const PredecessorCommitRequestV2Schema = SessionHandoffCommitRequestSchema.extend({
  sessionId: z.string().min(1).max(256),
  attemptId: z.string().min(1).max(256),
}).strict();

const PredecessorAbortRequestV2Schema = SessionHandoffAbortRequestSchema.extend({
  sessionId: z.string().min(1).max(256),
}).strict();

function invalidRequest() {
  return { ok: false, errorCode: 'invalid_request' } as const;
}

function isExactPreparedTarget(
  job: SessionHandoffPrepareTargetJobRecordV2 | null,
  input: Readonly<{ handoffId: string; sessionId: string }>,
): job is SessionHandoffPrepareTargetJobRecordV2 & Readonly<{
  recordKind: 'prepared_target';
  sessionId: string;
}> {
  return job?.recordKind === 'prepared_target'
    && job.handoffId === input.handoffId
    && job.sessionId === input.sessionId;
}

/**
 * Register the semantic RPC adapter for the exact remote-dev 1b32cdc6 V2 handoff caller.
 *
 * This adapter delegates preparation, result lookup, commit, and abort to the current canonical
 * owners. Target resume remains fail-closed until canonical spawn exposes equivalent acceptance
 * evidence. The adapter owns no parallel job store or orchestration lifecycle.
 */
export function registerSessionHandoffPredecessorCompatibilityHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  prepareTarget: (raw: unknown) => Promise<unknown>;
  prepareTargetResultGet: (raw: unknown) => Promise<unknown>;
  commit: (raw: unknown) => Promise<unknown>;
  abort: (raw: unknown) => Promise<unknown>;
  spawnSessionForHandoff?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSessionForHandoff?: (
    sessionId: string,
  ) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  now?: () => number;
  createOperationId?: (kind: 'commit' | 'abort') => string;
}>): void {
  const now = input.now ?? Date.now;
  const createOperationId = input.createOperationId
    ?? ((kind: 'commit' | 'abort') => `${kind}_${randomUUID()}`);

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
    async (raw: unknown) => {
      if (!asRecord(raw) || Object.keys(raw as JsonRecord).length !== 0) return invalidRequest();
      return {
        protocolVersion: 2,
        // The current canonical spawn result exposes session identity but not the predecessor's
        // pre-launch acceptance hook or runner-ownership disposition. Function presence cannot
        // safely advertise atomic resume or cleanup authority.
        atomicTargetResume: false,
        targetCleanup: false,
      } as const;
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
    async (raw: unknown) => {
      const parsed = PredecessorPrepareTargetRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const { sessionId, ...canonicalRequest } = parsed.data;
      const result = await input.prepareTarget(canonicalRequest);
      const finalResponse = SessionHandoffPrepareTargetResponseSchema.safeParse(result);
      if (finalResponse.success && finalResponse.data.resume) {
        const job = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
        if (!job) return { ok: false, errorCode: 'not_found' } as const;
        await input.prepareJobStore.upgradeReadyV1ToPreparedV2({
          jobId: job.jobId,
          sessionId,
        });
      }
      return projectSessionHandoffResponseForPredecessor('prepare', result);
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
    async (raw: unknown) => {
      const parsed = PredecessorResultGetRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const result = await input.prepareTargetResultGet({
        handoffId: parsed.data.handoffId,
      });
      const finalResponse = SessionHandoffPrepareTargetResponseSchema.safeParse(result);
      if (!finalResponse.success) return result;
      const job = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      if (!job) return { ok: false, errorCode: 'not_found' } as const;
      try {
        await input.prepareJobStore.upgradeReadyV1ToPreparedV2({
          jobId: job.jobId,
          sessionId: parsed.data.sessionId,
        });
      } catch {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      return projectSessionHandoffResponseForPredecessor('prepare', result);
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
    async (raw: unknown) => {
      const parsed = PredecessorTargetResumeRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      return { ok: false, errorCode: 'unsupported' } as const;
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
    async (raw: unknown) => {
      const parsed = PredecessorTargetConfirmRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (
        job.terminal.status === 'open'
        && job.resume.status === 'confirmed'
        && job.resume.attemptId === parsed.data.attemptId
      ) {
        return projectStatus(job.status);
      }
      const confirmedAtMs = now();
      const transitioned = await input.prepareJobStore.transitionPredecessorV2(
        job.jobId,
        (current) => {
          if (
            current.recordKind !== 'prepared_target'
            || current.terminal.status !== 'open'
            || current.resume.status !== 'attempted'
            || current.resume.attemptId !== parsed.data.attemptId
          ) {
            throw new Error('Target confirmation does not match the accepted predecessor attempt');
          }
          return {
            ...current,
            updatedAtMs: confirmedAtMs,
            transitionRevision: current.transitionRevision + 1,
            resume: {
              ...current.resume,
              status: 'confirmed',
              confirmedAtMs,
            },
          };
        },
      );
      return transitioned ? projectStatus(transitioned.status) : { ok: false, errorCode: 'not_found' };
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2,
    async (raw: unknown) => {
      const parsed = PredecessorCommitRequestV2Schema.safeParse(raw);
      if (!parsed.success || (parsed.data.mode ?? 'target') !== 'target') return invalidRequest();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (
        job.terminal.status === 'completed'
        && job.resume.status === 'confirmed'
        && job.resume.attemptId === parsed.data.attemptId
      ) {
        return projectStatusResponseForPredecessor(await input.commit({
          handoffId: parsed.data.handoffId,
          mode: 'target',
          ...(parsed.data.workspaceReplicationReverseSourceRootPath
            ? {
                workspaceReplicationReverseSourceRootPath:
                  parsed.data.workspaceReplicationReverseSourceRootPath,
              }
            : {}),
          ...(parsed.data.workspaceReplicationReverseTargetRootPath
            ? {
                workspaceReplicationReverseTargetRootPath:
                  parsed.data.workspaceReplicationReverseTargetRootPath,
              }
            : {}),
        }));
      }
      const committedAtMs = now();
      await input.prepareJobStore.transitionPredecessorV2(job.jobId, (current) => {
        if (
          current.recordKind !== 'prepared_target'
          || current.terminal.status !== 'open'
          || current.resume.status !== 'confirmed'
          || current.resume.attemptId !== parsed.data.attemptId
        ) {
          throw new Error('Target commit requires the exact confirmed predecessor attempt');
        }
        const nextRevision = current.transitionRevision + 1;
        return {
          ...current,
          updatedAtMs: committedAtMs,
          completedAtMs: committedAtMs,
          transitionRevision: nextRevision,
          terminal: {
            status: 'completed',
            operationId: createOperationId('commit'),
            completedRevision: nextRevision,
          },
          status: {
            ...current.status,
            status: 'completed',
            recoveryActions: [],
          },
        };
      });
      return projectStatusResponseForPredecessor(await input.commit({
        handoffId: parsed.data.handoffId,
        mode: 'target',
        ...(parsed.data.workspaceReplicationReverseSourceRootPath
          ? {
              workspaceReplicationReverseSourceRootPath:
                parsed.data.workspaceReplicationReverseSourceRootPath,
            }
          : {}),
        ...(parsed.data.workspaceReplicationReverseTargetRootPath
          ? {
              workspaceReplicationReverseTargetRootPath:
                parsed.data.workspaceReplicationReverseTargetRootPath,
            }
          : {}),
      }));
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
    async (raw: unknown) => {
      const parsed = PredecessorAbortRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (job.terminal.status === 'completed') {
        return projectStatusResponseForPredecessor({
          handoffId: job.handoffId,
          status: job.status,
          targetCleanup: job.targetCleanup,
        });
      }
      if (job.terminal.status === 'aborted') {
        const canonical = await input.abort({
          handoffId: parsed.data.handoffId,
          reason: parsed.data.reason,
        });
        return projectStatusResponseForPredecessor({
          ...(asRecord(canonical) ?? {}),
          handoffId: job.handoffId,
          status: asRecord(canonical)?.status ?? job.status,
          targetCleanup: job.targetCleanup,
        });
      }
      const ambiguousResume = job.resume.status === 'attempted' || job.resume.status === 'confirmed';
      const cleanupAttemptedAtMs = now();
      if (ambiguousResume) {
        const failed = await input.prepareJobStore.transitionPredecessorV2(
          job.jobId,
          (current) => ({
            ...current,
            updatedAtMs: cleanupAttemptedAtMs,
            transitionRevision: current.transitionRevision + 1,
            targetCleanup: {
              status: 'failed',
              reason: 'unreachable',
              attemptedAtMs: cleanupAttemptedAtMs,
            },
            status: {
              ...current.status,
              status: 'awaiting_recovery',
              recoveryActions: ['keep_stopped'],
            },
          }),
        );
        return projectStatusResponseForPredecessor({
          handoffId: job.handoffId,
          status: failed?.status ?? job.status,
          targetCleanup: failed?.recordKind === 'prepared_target'
            ? failed.targetCleanup
            : job.targetCleanup,
        });
      }
      const abortedAtMs = now();
      const operationId = createOperationId('abort');
      const transitioned = await input.prepareJobStore.transitionPredecessorV2(
        job.jobId,
        (current) => {
          if (current.recordKind !== 'prepared_target' || current.terminal.status !== 'open') {
            throw new Error('Target abort requires exact open predecessor ownership');
          }
          const nextRevision = current.transitionRevision + 1;
          const targetCleanup = current.resume.status === 'preexisting_unowned'
            ? {
                status: 'not_owned' as const,
                reason: 'preexisting_or_adopted' as const,
              }
            : {
                status: 'not_owned' as const,
                reason: 'resume_not_attempted' as const,
              };
          return {
            ...current,
            updatedAtMs: abortedAtMs,
            cancelRequestedAtMs: current.cancelRequestedAtMs ?? abortedAtMs,
            abortedAtMs,
            transitionRevision: nextRevision,
            terminal: {
              status: 'aborted',
              operationId,
              completedRevision: nextRevision,
            },
            targetCleanup,
            status: {
              ...current.status,
              status: 'aborted',
              recoveryActions: ['restart_on_source', 'keep_stopped'],
            },
          };
        },
      );
      const canonical = await input.abort({
        handoffId: parsed.data.handoffId,
        reason: parsed.data.reason,
      });
      const canonicalResponse = asRecord(canonical);
      return projectStatusResponseForPredecessor({
        ...(canonicalResponse ?? {}),
        handoffId: parsed.data.handoffId,
        status: canonicalResponse?.status ?? transitioned?.status ?? job.status,
        targetCleanup: transitioned?.recordKind === 'prepared_target'
          ? transitioned.targetCleanup
          : job.targetCleanup,
      });
    },
  );
}
