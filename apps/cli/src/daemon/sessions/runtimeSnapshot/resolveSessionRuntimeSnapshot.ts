import type { Metadata, PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import {
  resolveModelOverrideFromMetadataSnapshot,
  resolvePermissionIntentFromMetadataSnapshot,
  resolveSessionModeOverrideFromMetadataSnapshot,
} from '@/agent/runtime/permissions/modeFromMetadata';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceMaterializationIdentityV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import {
  readConnectedServiceMaterializationIdentityFromEnvironment,
  readConnectedServiceMaterializationIdentityFromMetadata,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '@/daemon/connectedServices/materialization/identity';

type SnapshotValue<T extends string> = Readonly<{ value: T; updatedAt: number }>;

export type SessionRuntimeSnapshot = Readonly<{
  sessionId: string | null;
  connectedServices: ConnectedServiceBindingsV1 | null;
  connectedServicesUpdatedAt: number | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  permissionMode: SnapshotValue<PermissionMode> | null;
  agentModeId: SnapshotValue<string> | null;
  modelId: SnapshotValue<string> | null;
  vendorResumeId: Readonly<{ value: string; updatedAt: number | null }> | null;
}>;

export type ResolveSessionRuntimeSnapshotParams = Readonly<{
  incomingOptions: SpawnSessionOptions;
  persistedMetadata?: Record<string, unknown> | null;
  trackedSpawnOptions?: SpawnSessionOptions | null;
  persistedVendorResumeId?: string | null;
  trackedVendorResumeId?: string | null;
}>;

export type ResolveSessionRuntimeSnapshotResult = Readonly<{
  snapshot: SessionRuntimeSnapshot;
  spawnOptions: SpawnSessionOptions;
}>;

type CandidateSource = 'persisted' | 'tracked' | 'incoming';
type TimestampedCandidate<T extends string> = SnapshotValue<T> & Readonly<{ source: CandidateSource }>;
type ConnectedServicesCandidate = Readonly<{
  source: CandidateSource;
  value: ConnectedServiceBindingsV1;
  updatedAt: number | null;
}>;
type SpawnSessionOptionsWithConnectedServicesTimestamp = SpawnSessionOptions & {
  connectedServicesUpdatedAt?: unknown;
};

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  persisted: 1,
  tracked: 2,
  incoming: 3,
};

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFiniteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readSessionId(options: SpawnSessionOptions): string | null {
  return normalizeNonEmptyString(options.existingSessionId) ?? normalizeNonEmptyString(options.sessionId);
}

function parseConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hasBoundConnectedService(value: ConnectedServiceBindingsV1 | null): value is ConnectedServiceBindingsV1 {
  return Boolean(value && Object.keys(value.bindingsByServiceId).length > 0);
}

function readConnectedServicesCandidate(
  value: unknown,
  updatedAtValue: unknown,
  source: CandidateSource,
): ConnectedServicesCandidate | null {
  if (value === undefined) return null;
  const parsed = parseConnectedServices(value);
  if (!parsed) return null;
  return {
    source,
    value: parsed,
    updatedAt: normalizeFiniteTimestamp(updatedAtValue),
  };
}

function readConnectedServicesUpdatedAt(
  options: SpawnSessionOptions | null | undefined,
): unknown {
  if (!options || typeof options !== 'object') return undefined;
  return (options as SpawnSessionOptionsWithConnectedServicesTimestamp).connectedServicesUpdatedAt;
}

function chooseConnectedServicesCandidate(
  candidates: ReadonlyArray<ConnectedServicesCandidate | null>,
): ConnectedServicesCandidate | null {
  const valid = candidates.filter((candidate): candidate is ConnectedServicesCandidate => candidate !== null);
  if (valid.length < 1) return null;

  const timestamped = valid.filter((candidate) => candidate.updatedAt !== null);
  if (timestamped.length > 0) {
    return [...timestamped].sort((left, right) => {
      const timestampDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (timestampDelta !== 0) return timestampDelta;
      return SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
    })[0];
  }

  const bound = valid.filter((candidate) => hasBoundConnectedService(candidate.value));
  if (bound.length > 0) {
    return [...bound].sort((left, right) => SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source])[0];
  }

  return [...valid].sort((left, right) => SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source])[0];
}

function chooseTimestamped<T extends string>(
  candidates: ReadonlyArray<TimestampedCandidate<T> | null>,
): SnapshotValue<T> | null {
  const valid = candidates.filter((candidate): candidate is TimestampedCandidate<T> => candidate !== null);
  if (valid.length < 1) return null;

  const chosen = [...valid].sort((left, right) => {
    const timestampDelta = right.updatedAt - left.updatedAt;
    if (timestampDelta !== 0) return timestampDelta;
    return SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
  })[0];
  return { value: chosen.value, updatedAt: chosen.updatedAt };
}

function readPermissionFromOptions(
  options: SpawnSessionOptions | null | undefined,
  source: CandidateSource,
): TimestampedCandidate<PermissionMode> | null {
  const value = normalizeNonEmptyString(options?.permissionMode);
  const updatedAt = normalizeFiniteTimestamp(options?.permissionModeUpdatedAt);
  if (!value || updatedAt === null || !isPermissionMode(value)) return null;
  return { source, value, updatedAt };
}

function readPermissionFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TimestampedCandidate<PermissionMode> | null {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({ metadata: metadata as Metadata | null | undefined });
  return resolved ? { source: 'persisted', value: resolved.intent, updatedAt: resolved.updatedAt } : null;
}

function readStringControlFromOptions(
  options: SpawnSessionOptions | null | undefined,
  valueKey: 'agentModeId' | 'modelId',
  updatedAtKey: 'agentModeUpdatedAt' | 'modelUpdatedAt',
  source: CandidateSource,
): TimestampedCandidate<string> | null {
  const value = normalizeNonEmptyString(options?.[valueKey]);
  const updatedAt = normalizeFiniteTimestamp(options?.[updatedAtKey]);
  return value && updatedAt !== null ? { source, value, updatedAt } : null;
}

function readDirectStringControlFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  valueKey: 'agentModeId' | 'modelId',
  updatedAtKey: 'agentModeUpdatedAt' | 'modelUpdatedAt',
): TimestampedCandidate<string> | null {
  const value = normalizeNonEmptyString(metadata?.[valueKey]);
  const updatedAt = normalizeFiniteTimestamp(metadata?.[updatedAtKey]);
  return value && updatedAt !== null ? { source: 'persisted', value, updatedAt } : null;
}

function readAgentModeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TimestampedCandidate<string> | null {
  const direct = readDirectStringControlFromMetadata(metadata, 'agentModeId', 'agentModeUpdatedAt');
  const resolved = resolveSessionModeOverrideFromMetadataSnapshot({ metadata: metadata as Metadata | null | undefined });
  const fromOverride = resolved && resolved.modeId
    ? { source: 'persisted' as const, value: resolved.modeId, updatedAt: resolved.updatedAt }
    : null;
  const chosen = chooseTimestamped([direct, fromOverride]);
  return chosen ? { source: 'persisted', ...chosen } : null;
}

function readModelFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TimestampedCandidate<string> | null {
  const direct = readDirectStringControlFromMetadata(metadata, 'modelId', 'modelUpdatedAt');
  const resolved = resolveModelOverrideFromMetadataSnapshot({ metadata: metadata as Metadata | null | undefined });
  const fromOverride = resolved
    ? { source: 'persisted' as const, value: resolved.modelId, updatedAt: resolved.updatedAt }
    : null;
  const chosen = chooseTimestamped([direct, fromOverride]);
  return chosen ? { source: 'persisted', ...chosen } : null;
}

function chooseVendorResumeId(params: ResolveSessionRuntimeSnapshotParams): SessionRuntimeSnapshot['vendorResumeId'] {
  const value =
    normalizeNonEmptyString(params.incomingOptions.resume)
    ?? normalizeNonEmptyString(params.trackedSpawnOptions?.resume)
    ?? normalizeNonEmptyString(params.trackedVendorResumeId)
    ?? normalizeNonEmptyString(params.persistedVendorResumeId);
  return value ? { value, updatedAt: null } : null;
}

function chooseConnectedServiceMaterializationIdentity(
  params: ResolveSessionRuntimeSnapshotParams,
): ConnectedServiceMaterializationIdentityV1 | null {
  return readConnectedServiceMaterializationIdentityFromMetadata(params.persistedMetadata)
    ?? readConnectedServiceMaterializationIdentityFromSpawnOptions(params.trackedSpawnOptions)
    ?? readConnectedServiceMaterializationIdentityFromEnvironment(params.trackedSpawnOptions?.environmentVariables)
    ?? readConnectedServiceMaterializationIdentityFromSpawnOptions(params.incomingOptions)
    ?? readConnectedServiceMaterializationIdentityFromEnvironment(params.incomingOptions.environmentVariables);
}

function applySnapshotToSpawnOptions(
  options: SpawnSessionOptions,
  snapshot: SessionRuntimeSnapshot,
): SpawnSessionOptions {
  // The snapshot's spawn options are the DURABLE respawn/resume identity (persisted as tracked
  // spawn options and replayed by crash/auth respawns). One-shot delivery fields from a single
  // resume RPC must not survive into it: a stale `initialTranscriptAfterSeq` makes every later
  // respawn replay already-processed user messages through the explicit startup catch-up, and a
  // stale `initialPrompt` is equally single-use.
  const {
    initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
    initialPrompt: _initialPrompt,
    ...durableOptions
  } = options;
  const next: SpawnSessionOptions = { ...durableOptions };

  if (snapshot.connectedServices) {
    next.connectedServices = snapshot.connectedServices;
    if (snapshot.connectedServicesUpdatedAt !== null) {
      (next as SpawnSessionOptionsWithConnectedServicesTimestamp).connectedServicesUpdatedAt =
        snapshot.connectedServicesUpdatedAt;
    }
  }

  if (snapshot.connectedServiceMaterializationIdentityV1) {
    next.connectedServiceMaterializationIdentityV1 = snapshot.connectedServiceMaterializationIdentityV1;
  }

  if (snapshot.permissionMode) {
    next.permissionMode = snapshot.permissionMode.value;
    next.permissionModeUpdatedAt = snapshot.permissionMode.updatedAt;
  }

  if (snapshot.agentModeId) {
    next.agentModeId = snapshot.agentModeId.value;
    next.agentModeUpdatedAt = snapshot.agentModeId.updatedAt;
  }

  if (snapshot.modelId) {
    next.modelId = snapshot.modelId.value;
    next.modelUpdatedAt = snapshot.modelId.updatedAt;
  }

  if (snapshot.vendorResumeId) {
    next.resume = snapshot.vendorResumeId.value;
  }

  return next;
}

export function resolveSessionRuntimeSnapshot(
  params: ResolveSessionRuntimeSnapshotParams,
): ResolveSessionRuntimeSnapshotResult {
  const connectedServices = chooseConnectedServicesCandidate([
    readConnectedServicesCandidate(
      params.persistedMetadata?.connectedServices,
      params.persistedMetadata?.connectedServicesUpdatedAt,
      'persisted',
    ),
    readConnectedServicesCandidate(
      params.trackedSpawnOptions?.connectedServices,
      readConnectedServicesUpdatedAt(params.trackedSpawnOptions),
      'tracked',
    ),
    readConnectedServicesCandidate(
      params.incomingOptions.connectedServices,
      readConnectedServicesUpdatedAt(params.incomingOptions),
      'incoming',
    ),
  ]);

  const snapshot: SessionRuntimeSnapshot = {
    sessionId: readSessionId(params.incomingOptions),
    connectedServices: connectedServices?.value ?? null,
    connectedServicesUpdatedAt: connectedServices?.updatedAt ?? null,
    connectedServiceMaterializationIdentityV1: chooseConnectedServiceMaterializationIdentity(params),
    permissionMode: chooseTimestamped([
      readPermissionFromMetadata(params.persistedMetadata),
      readPermissionFromOptions(params.trackedSpawnOptions, 'tracked'),
      readPermissionFromOptions(params.incomingOptions, 'incoming'),
    ]),
    agentModeId: chooseTimestamped([
      readAgentModeFromMetadata(params.persistedMetadata),
      readStringControlFromOptions(params.trackedSpawnOptions, 'agentModeId', 'agentModeUpdatedAt', 'tracked'),
      readStringControlFromOptions(params.incomingOptions, 'agentModeId', 'agentModeUpdatedAt', 'incoming'),
    ]),
    modelId: chooseTimestamped([
      readModelFromMetadata(params.persistedMetadata),
      readStringControlFromOptions(params.trackedSpawnOptions, 'modelId', 'modelUpdatedAt', 'tracked'),
      readStringControlFromOptions(params.incomingOptions, 'modelId', 'modelUpdatedAt', 'incoming'),
    ]),
    vendorResumeId: chooseVendorResumeId(params),
  };

  return {
    snapshot,
    spawnOptions: applySnapshotToSpawnOptions(params.incomingOptions, snapshot),
  };
}
