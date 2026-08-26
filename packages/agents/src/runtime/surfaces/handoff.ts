import {
  EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  type BackendSurfaceAvailabilityV1,
  type AgentNativeResumeIdentityV1,
  type PluginAgentExternalSessionLinkDataValue,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  BackendSessionLaunchHintsV1,
  BackendSurfaceResultV1,
} from './primitives.js';
import { readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata } from '../identity/readAgentSurfaceRuntimeDescriptorV1.js';

export type HandoffAvailabilityRequestV1 = Readonly<{
  operation: 'exportBundle' | 'importBundle';
  sessionId?: string;
  metadata?: HandoffExportSessionMetadataV1;
}>;

export type HandoffRuntimeLocalExternalSessionSourceV1 = Readonly<{
  kind: string;
} & Record<string, PluginAgentExternalSessionLinkDataValue>>;

export type HandoffExportSessionMetadataV1 = Readonly<Partial<{
  path: string;
  /** Bounded Session runtime identity, interpreted only by the target Agent. */
  runtimeDescriptorV1: RuntimeDescriptorV1;
  externalSessionSource: HandoffRuntimeLocalExternalSessionSourceV1;
}>>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isExternalSessionSourceOwnedByAgent(
  agentId: string,
  sourceKind: string,
): boolean {
  const knownAgentIds = Object.entries(
    EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1,
  ).find(([knownSourceKind]) => knownSourceKind === sourceKind)?.[1];
  return knownAgentIds === undefined || knownAgentIds.some(
    (knownAgentId) => knownAgentId === agentId,
  );
}

/** Strict metadata view for every Agent-owned handoff callback. Host-only facts stay separate. */
export function projectSessionMetadataForAgentHandoff(
  value: unknown,
): HandoffExportSessionMetadataV1 {
  const metadata = asRecord(value);
  const linkedExternalSessionV1 = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  const runtimeDescriptorV1 = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(metadata);
  const linkedExternalSessionSource = linkedExternalSessionV1
    && isExternalSessionSourceOwnedByAgent(
      linkedExternalSessionV1.agentId,
      linkedExternalSessionV1.source.kind,
    )
    ? linkedExternalSessionV1.source
    : undefined;
  return Object.freeze({
    ...(readString(metadata.path) !== undefined
      ? { path: readString(metadata.path) }
      : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(linkedExternalSessionSource ? { externalSessionSource: linkedExternalSessionSource } : {}),
  });
}

export type HandoffExportRequestV1 = Readonly<{
  sessionId: string;
  metadata: HandoffExportSessionMetadataV1;
  directory: string;
}>;

export type HandoffExportResultV1 = Readonly<{
  bundle: Readonly<Record<string, unknown>>;
}>;

export type HandoffImportRequestV1 = Readonly<{
  bundle: Readonly<Record<string, unknown>>;
  targetDirectory: string;
}>;

export type HandoffImportResultV1 = Readonly<{
  providerSessionId: string;
  source?: Readonly<{ kind: string }>;
  launch: BackendSessionLaunchHintsV1;
}>;

/** Agent-owned decoding of an otherwise opaque exported handoff bundle. */
export type HandoffMediaScannableRecordsRequestV1 = Readonly<{
  bundle: Readonly<Record<string, unknown>>;
}>;

/** Bounded host identity supplied to an Agent-owned local-handoff projection. */
export type HandoffRuntimeLocalMetadataIdentityV1 = Readonly<{
  machineId: string | null;
  workingDirectory: string | null;
  transcriptStorage: 'direct' | 'persisted' | null;
  vendorResumeId: string;
}>;

/**
 * Agent-owned local metadata is limited to its external-session source. The
 * host remains the sole writer of Session identity, machine, timestamp, and
 * persisted metadata.
 */
export type HandoffRuntimeLocalMetadataV1 = Readonly<Partial<{
  externalSessionSource: HandoffRuntimeLocalExternalSessionSourceV1;
}>>;

export type HandoffRuntimeLocalMetadataRequestV1 = Readonly<{
  identity: HandoffRuntimeLocalMetadataIdentityV1;
  runtimeDescriptorV1: RuntimeDescriptorV1;
}>;

/** Agent-native transcript layout candidate; host verifies the real path and containment. */
export type HandoffNativeTranscriptPathCandidateV1 = Readonly<{
  path: string;
  containmentRoot: string;
}>;

export type HandoffNativeTranscriptPathCandidateRequestV1 = Readonly<{
  identity: AgentNativeResumeIdentityV1;
  runtimeDescriptorV1: RuntimeDescriptorV1;
}>;

export type HandoffFailureCodeV1 =
  | 'bundle_invalid'
  | 'target_import_failed'
  | 'target_identity_conflict'
  | 'agent_version_unsupported'
  | 'handoff_failed';

export type HandoffSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: HandoffAvailabilityRequestV1) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  exportBundle: (request: HandoffExportRequestV1) => BackendSurfaceResultV1<HandoffExportResultV1, HandoffFailureCodeV1> | Promise<BackendSurfaceResultV1<HandoffExportResultV1, HandoffFailureCodeV1>>;
  importBundle: (request: HandoffImportRequestV1) => BackendSurfaceResultV1<HandoffImportResultV1, HandoffFailureCodeV1> | Promise<BackendSurfaceResultV1<HandoffImportResultV1, HandoffFailureCodeV1>>;
  extractMediaScannableRecords?: (request: HandoffMediaScannableRecordsRequestV1) => readonly unknown[] | Promise<readonly unknown[]>;
  buildRuntimeLocalMetadata?: (request: HandoffRuntimeLocalMetadataRequestV1) => HandoffRuntimeLocalMetadataV1 | null | Promise<HandoffRuntimeLocalMetadataV1 | null>;
  resolveNativeTranscriptPathCandidate?: (request: HandoffNativeTranscriptPathCandidateRequestV1) => HandoffNativeTranscriptPathCandidateV1 | null | Promise<HandoffNativeTranscriptPathCandidateV1 | null>;
}>;
