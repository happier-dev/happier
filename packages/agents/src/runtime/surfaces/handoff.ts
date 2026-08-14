import {
  EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1,
  readLinkedExternalSessionV1FromMetadata,
  type BackendSurfaceAvailabilityV1,
  type PluginAgentExternalSessionLinkDataValue,
} from '@happier-dev/protocol';
import type {
  BackendSessionLaunchHintsV1,
  BackendSurfaceResultV1,
} from './primitives.js';
import { readProviderSessionIdSessionState } from '../../session/state/bindings/providerSessionId.js';
import { readSessionMetadataRuntimeDescriptor } from '../../runtime/identity/readSessionMetadataRuntimeDescriptor.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../runtime/identity/runtimeDescriptorTypes.js';

export type HandoffAvailabilityRequestV1 = Readonly<{
  operation: 'exportBundle' | 'importBundle';
  sessionId?: string;
  metadata?: HandoffExportSessionMetadataV1;
}>;

type AgentExternalSessionSource = Readonly<{
  kind: string;
} & Record<string, PluginAgentExternalSessionLinkDataValue>>;

export type HandoffExportSessionMetadataV1 = Readonly<Partial<{
  path: string;
  providerSessionId: string;
  claudeSessionId: string;
  codexSessionId: string;
  codexBackendMode: string;
  opencodeSessionId: string;
  opencodeBackendMode: string;
  opencodeServerBaseUrl: string;
  opencodeServerBaseUrlExplicit: boolean;
  externalSessionSource: AgentExternalSessionSource;
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

function projectCodexRuntimeSource(
  descriptor: SharedRuntimeDescriptorByProviderId['codex'] | null,
): AgentExternalSessionSource | undefined {
  if (descriptor?.home === 'user') {
    return { kind: 'codexHome', home: 'user' };
  }
  if (
    descriptor?.home !== 'connectedService'
    || !descriptor.connectedServiceId
  ) {
    return undefined;
  }
  return {
    kind: 'codexHome',
    home: 'connectedService',
    connectedServiceId: descriptor.connectedServiceId,
    ...(descriptor.connectedServiceProfileId
      ? { connectedServiceProfileId: descriptor.connectedServiceProfileId }
      : {}),
    ...(descriptor.connectedServiceGroupId
      ? { connectedServiceGroupId: descriptor.connectedServiceGroupId }
      : {}),
  };
}

/** Strict metadata view for every Agent-owned handoff callback. Host-only facts stay separate. */
export function projectSessionMetadataForAgentHandoff(
  value: unknown,
): HandoffExportSessionMetadataV1 {
  const metadata = asRecord(value);
  const linkedExternalSessionV1 = readLinkedExternalSessionV1FromMetadata(metadata);
  const providerSessionId = readProviderSessionIdSessionState(metadata).value;
  const codexRuntimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const openCodeRuntimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'opencode');
  const linkedExternalSessionSource = linkedExternalSessionV1
    && isExternalSessionSourceOwnedByAgent(
      linkedExternalSessionV1.agentId,
      linkedExternalSessionV1.source.kind,
    )
    ? linkedExternalSessionV1.source
    : undefined;
  const hasLinkedSessionInput = Object.prototype.hasOwnProperty.call(metadata, 'externalSessionV1')
    || Object.prototype.hasOwnProperty.call(metadata, 'directSessionV1');
  const externalSessionSource = linkedExternalSessionSource
    ?? (!hasLinkedSessionInput
      ? projectCodexRuntimeSource(codexRuntimeDescriptor)
      : undefined);
  const codexBackendMode = codexRuntimeDescriptor?.runtimeKind
    ?? (linkedExternalSessionV1?.agentId === 'codex' && externalSessionSource
      ? readString(linkedExternalSessionV1.codexBackendMode)
      : undefined);
  return Object.freeze({
    ...(readString(metadata.path) !== undefined
      ? { path: readString(metadata.path) }
      : {}),
    ...(providerSessionId !== null
      ? { providerSessionId }
      : {}),
    ...(readString(metadata.claudeSessionId) !== undefined
      ? { claudeSessionId: readString(metadata.claudeSessionId) }
      : {}),
    ...(codexRuntimeDescriptor?.providerSessionId
      ? { codexSessionId: codexRuntimeDescriptor.providerSessionId }
      : readString(metadata.codexSessionId) !== undefined
        ? { codexSessionId: readString(metadata.codexSessionId) }
      : {}),
    ...(codexBackendMode !== undefined
      ? { codexBackendMode }
      : {}),
    ...(openCodeRuntimeDescriptor?.providerSessionId
      ? { opencodeSessionId: openCodeRuntimeDescriptor.providerSessionId }
      : {}),
    ...(openCodeRuntimeDescriptor?.backendMode
      ? { opencodeBackendMode: openCodeRuntimeDescriptor.backendMode }
      : {}),
    ...(openCodeRuntimeDescriptor?.serverBaseUrl
      ? { opencodeServerBaseUrl: openCodeRuntimeDescriptor.serverBaseUrl }
      : {}),
    ...(openCodeRuntimeDescriptor?.serverBaseUrl
      ? { opencodeServerBaseUrlExplicit: openCodeRuntimeDescriptor.serverBaseUrlExplicit }
      : {}),
    ...(externalSessionSource ? { externalSessionSource } : {}),
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
}>;
