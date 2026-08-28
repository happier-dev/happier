import type { Metadata, PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import {
  resolveAgentIdFromSessionMetadata,
  resolveModelSelectionIntentFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  resolvePermissionIntentFromMetadataSnapshot,
  resolveSessionModeOverrideFromMetadataSnapshot,
} from '@/agent/runtime/permissions/modeFromMetadata';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import {
  ConnectedServiceBindingsV1Schema,
  buildBackendTargetKeyV2,
  readRuntimeDescriptorV1FromMetadata,
  type ProviderBoundModelRef,
  type ConnectedServiceMaterializationIdentityV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
  readConnectedServiceMaterializationIdentityFromEnvironment,
  readConnectedServiceMaterializationIdentityFromMetadata,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '@/daemon/connectedServices/materialization/identity';
import { readPersistedProviderResumeState } from '@/providers/lifecycle/readPersistedResumeSelection';

type SnapshotValue<T> = Readonly<{ value: T; updatedAt: number }>;

export type SessionRuntimeSnapshot = Readonly<{
  sessionId: string | null;
  connectedServices: ConnectedServiceBindingsV1 | null;
  connectedServicesUpdatedAt: number | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  runtimeDescriptorV1: SpawnSessionOptions['runtimeDescriptorV1'] | null;
  permissionMode: SnapshotValue<PermissionMode> | null;
  agentModeId: SnapshotValue<string> | null;
  modelSelection: SnapshotValue<ProviderBoundModelRef | null> | null;
  vendorResumeId: Readonly<{ value: string; updatedAt: number | null }> | null;
}>;

export type ResolveSessionRuntimeSnapshotParams = Readonly<{
  incomingOptions: SpawnSessionOptions;
  persistedMetadata?: Record<string, unknown> | null;
  trackedSpawnOptions?: SpawnSessionOptions | null;
  persistedVendorResumeId?: string | null;
  trackedVendorResumeId?: string | null;
  /**
   * A retained live process already has one active model/binding envelope. Its
   * persisted model intent is for the next launch and must not rewrite the
   * identity of the process being adopted.
   */
  resolutionMode?: 'ordinary' | 'retained_live_process';
}>;

export type ResolveSessionRuntimeSnapshotResult = Readonly<{
  snapshot: SessionRuntimeSnapshot;
  spawnOptions: SpawnSessionOptions;
}>;

type CandidateSource = 'persisted' | 'tracked' | 'incoming';
type TimestampedCandidate<T> = SnapshotValue<T> & Readonly<{ source: CandidateSource }>;
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

function readAgentIdFromOptions(options: SpawnSessionOptions | null | undefined): CatalogAgentId | null {
  const descriptorAgentId = readRuntimeDescriptorV1FromMetadata({
    runtimeDescriptorV1: options?.runtimeDescriptorV1,
  })?.agentId;
  if (descriptorAgentId) return descriptorAgentId;
  const target = options?.backendTarget && typeof options.backendTarget === 'object'
    ? options.backendTarget as Record<string, unknown>
    : null;
  const rawAgentId =
    target?.kind === 'backend'
      ? target.backendId
      : target?.kind === 'builtInAgent'
        ? target.agentId
        : null;
  const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
  return agentId || null;
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

function chooseTimestamped<T>(
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
  valueKey: 'agentModeId',
  updatedAtKey: 'agentModeUpdatedAt',
  source: CandidateSource,
): TimestampedCandidate<string> | null {
  const value = normalizeNonEmptyString(options?.[valueKey]);
  const updatedAt = normalizeFiniteTimestamp(options?.[updatedAtKey]);
  return value && updatedAt !== null ? { source, value, updatedAt } : null;
}

function readDirectStringControlFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  valueKey: 'agentModeId',
  updatedAtKey: 'agentModeUpdatedAt',
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

function readModelFromOptions(
  options: SpawnSessionOptions | null | undefined,
  source: CandidateSource,
): TimestampedCandidate<ProviderBoundModelRef | null> | null {
  return options?.modelSelection
    ? { source, value: options.modelSelection.ref, updatedAt: options.modelSelection.updatedAt }
    : null;
}

function resolveModelTargetKey(params: ResolveSessionRuntimeSnapshotParams): string | null {
  const target = params.incomingOptions.agentTarget
    ?? params.trackedSpawnOptions?.agentTarget
    ?? params.incomingOptions.backendTarget
    ?? params.trackedSpawnOptions?.backendTarget
    ?? resolveBackendTargetFromSessionMetadata(params.persistedMetadata);
  return target ? buildBackendTargetKeyV2(target) : null;
}

function readModelFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentTargetKey: string | null,
): TimestampedCandidate<ProviderBoundModelRef | null> | null {
  if (!agentTargetKey) return null;
  const resolved = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
  return resolved
    ? { source: 'persisted', value: resolved.selection, updatedAt: resolved.updatedAt }
    : null;
}

function chooseExplicitVendorResumeId(params: ResolveSessionRuntimeSnapshotParams): string | null {
  return normalizeNonEmptyString(params.incomingOptions.resume)
    ?? normalizeNonEmptyString(params.trackedSpawnOptions?.resume);
}

function chooseVendorResumeId(
  params: ResolveSessionRuntimeSnapshotParams,
  explicitResumeId: string | null,
): SessionRuntimeSnapshot['vendorResumeId'] {
  const metadata = params.persistedMetadata ?? null;
  const agentId =
    readAgentIdFromOptions(params.incomingOptions)
    ?? readAgentIdFromOptions(params.trackedSpawnOptions)
    ?? resolveAgentIdFromSessionMetadata(metadata);
  const metadataVendorResumeId = agentId
    ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
    : null;
  if (explicitResumeId) return { value: explicitResumeId, updatedAt: null };

  // The persisted current view wins over a tracked runtime observation for every
  // Agent alike. A Claude-only divergence gate used to refuse the resume outright
  // here, on the strength of a continuity proof that no longer exists (`AM-24`);
  // there is nothing left for it to decide, and one rule for every Agent is what
  // keeps this from being a second resume decision-maker.
  const observedVendorResumeId =
    normalizeNonEmptyString(metadataVendorResumeId)
    ?? normalizeNonEmptyString(params.persistedVendorResumeId)
    ?? normalizeNonEmptyString(params.trackedVendorResumeId);
  return observedVendorResumeId
    ? { value: observedVendorResumeId, updatedAt: null }
    : null;
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
  explicitResumeId: string | null,
  retainedLiveRuntimeOptions?: SpawnSessionOptions | null,
): SpawnSessionOptions {
  // The snapshot's spawn options are the DURABLE respawn/resume identity (persisted as tracked
  // spawn options and replayed by crash/auth respawns). One-shot delivery fields from a single
  // resume RPC must not survive into it: a stale `initialTranscriptAfterSeq` makes every later
  // respawn replay already-processed user messages through the explicit startup catch-up.
  const {
    initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
    executionAuthorization: _executionAuthorization,
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

  if (snapshot.runtimeDescriptorV1) {
    next.runtimeDescriptorV1 = snapshot.runtimeDescriptorV1;
  }

  if (snapshot.permissionMode) {
    next.permissionMode = snapshot.permissionMode.value;
    next.permissionModeUpdatedAt = snapshot.permissionMode.updatedAt;
  }

  if (snapshot.agentModeId) {
    next.agentModeId = snapshot.agentModeId.value;
    next.agentModeUpdatedAt = snapshot.agentModeId.updatedAt;
  }

  if (snapshot.modelSelection) {
    if (snapshot.modelSelection.value) {
      next.modelSelection = {
        v: 1,
        ref: snapshot.modelSelection.value,
        updatedAt: snapshot.modelSelection.updatedAt,
      };
    } else {
      delete next.modelSelection;
    }
  }

  if (retainedLiveRuntimeOptions) {
    if (retainedLiveRuntimeOptions.modelSelection) {
      next.modelSelection = retainedLiveRuntimeOptions.modelSelection;
    } else {
      delete next.modelSelection;
    }
    if (retainedLiveRuntimeOptions.providerBindingMetadataV1) {
      next.providerBindingMetadataV1 =
        retainedLiveRuntimeOptions.providerBindingMetadataV1;
    } else {
      delete next.providerBindingMetadataV1;
    }
  }

  // Observed provider identity remains snapshot evidence. Only a host-authored Resume may enter
  // durable tracked options; otherwise a later refresh could mistake derived evidence for intent.
  if (explicitResumeId) {
    next.resume = explicitResumeId;
  } else {
    delete next.resume;
  }

  return next;
}

export function resolveSessionRuntimeSnapshot(
  params: ResolveSessionRuntimeSnapshotParams,
): ResolveSessionRuntimeSnapshotResult {
  // Persisted Provider selection and binding are one continuity envelope. Validate
  // that envelope before any source arbitration so malformed/orphan state cannot
  // be reinterpreted as native by takeover, respawn, or inactive replay callers.
  readPersistedProviderResumeState(params.persistedMetadata ?? null);

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

  const modelTargetKey = resolveModelTargetKey(params);
  const explicitResumeId = chooseExplicitVendorResumeId(params);
  const retainedLiveRuntimeOptions = params.resolutionMode === 'retained_live_process'
    ? params.trackedSpawnOptions ?? params.incomingOptions
    : null;
  const retainedLiveRuntimeSource = retainedLiveRuntimeOptions
    ? params.trackedSpawnOptions
      ? 'tracked'
      : 'incoming'
    : null;
  const snapshot: SessionRuntimeSnapshot = {
    sessionId: readSessionId(params.incomingOptions),
    connectedServices: connectedServices?.value ?? null,
    connectedServicesUpdatedAt: connectedServices?.updatedAt ?? null,
    connectedServiceMaterializationIdentityV1: chooseConnectedServiceMaterializationIdentity(params),
    runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(params.persistedMetadata),
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
    modelSelection: retainedLiveRuntimeOptions
      ? readModelFromOptions(retainedLiveRuntimeOptions, retainedLiveRuntimeSource!)
      : chooseTimestamped([
        readModelFromMetadata(params.persistedMetadata, modelTargetKey),
        readModelFromOptions(params.trackedSpawnOptions, 'tracked'),
        readModelFromOptions(params.incomingOptions, 'incoming'),
      ]),
    vendorResumeId: chooseVendorResumeId(params, explicitResumeId),
  };

  return {
    snapshot,
    spawnOptions: applySnapshotToSpawnOptions(
      params.incomingOptions,
      snapshot,
      explicitResumeId,
      retainedLiveRuntimeOptions,
    ),
  };
}
