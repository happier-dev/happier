import type { PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  AGENT_IDS,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  inferAgentIdFromSessionMetadata,
  resolveMetadataStringOverrideStateV1FromAliases,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
  SESSION_MODE_OVERRIDE_KEY,
  type AgentId,
} from '@happier-dev/agents';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  SessionMcpSelectionV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
  type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import {
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
  parseSessionConnectedServiceMaterializationIdentityJson,
} from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';

type SnapshotValue<T extends string> = Readonly<{ value: T; updatedAt: number }>;

export type SessionRuntimeSnapshot = Readonly<{
  sessionId: string | null;
  connectedServices: ConnectedServiceBindingsV1 | null;
  connectedServicesUpdatedAt: number | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  mcpSelection: SessionMcpSelectionV1 | null;
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
type MaterializationIdentityCandidate = Readonly<{
  value: ConnectedServiceMaterializationIdentityV1;
}>;

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

function readAgentIdFromOptions(options: SpawnSessionOptions | null | undefined): AgentId | null {
  const rawAgentId = options?.backendTarget?.kind === 'builtInAgent' ? options.backendTarget.agentId : null;
  return typeof rawAgentId === 'string' && (AGENT_IDS as readonly string[]).includes(rawAgentId)
    ? rawAgentId as AgentId
    : null;
}

function parseConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMaterializationIdentity(value: unknown): ConnectedServiceMaterializationIdentityV1 | null {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMcpSelection(value: unknown): SessionMcpSelectionV1 | null {
  if (value === undefined || value === null) return null;
  const parsed = SessionMcpSelectionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readMaterializationIdentityCandidate(value: unknown): MaterializationIdentityCandidate | null {
  const parsed = parseMaterializationIdentity(value);
  return parsed ? { value: parsed } : null;
}

function readMaterializationIdentityFromOptionsEnv(
  options: SpawnSessionOptions | null | undefined,
): MaterializationIdentityCandidate | null {
  const raw = options?.environmentVariables?.[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY];
  const parsed = parseSessionConnectedServiceMaterializationIdentityJson(typeof raw === 'string' ? raw : null);
  return parsed ? { value: parsed } : null;
}

function chooseMaterializationIdentityCandidate(
  candidates: ReadonlyArray<MaterializationIdentityCandidate | null>,
): MaterializationIdentityCandidate | null {
  return candidates.find((candidate): candidate is MaterializationIdentityCandidate => candidate !== null) ?? null;
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
  const resolved = resolvePermissionIntentFromSessionMetadata(metadata ?? null);
  return resolved && isPermissionMode(resolved.intent)
    ? { source: 'persisted', value: resolved.intent, updatedAt: resolved.updatedAt }
    : null;
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

function readAgentModeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TimestampedCandidate<string> | null {
  const directValue = normalizeNonEmptyString(metadata?.agentModeId);
  const directUpdatedAt = normalizeFiniteTimestamp(metadata?.agentModeUpdatedAt);
  const direct = directValue && directUpdatedAt !== null
    ? { source: 'persisted' as const, value: directValue, updatedAt: directUpdatedAt }
    : null;

  const resolved = resolveMetadataStringOverrideStateV1FromAliases(
    metadata ?? null,
    [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
    'modeId',
  );
  const fromOverride = resolved?.state === 'set' && resolved.value !== 'default'
    ? { source: 'persisted' as const, value: resolved.value, updatedAt: resolved.updatedAt }
    : null;

  const chosen = chooseTimestamped([direct, fromOverride]);
  return chosen ? { source: 'persisted', ...chosen } : null;
}

function readModelFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TimestampedCandidate<string> | null {
  const directValue = normalizeNonEmptyString(metadata?.modelId);
  const directUpdatedAt = normalizeFiniteTimestamp(metadata?.modelUpdatedAt);
  const direct = directValue && directUpdatedAt !== null
    ? { source: 'persisted' as const, value: directValue, updatedAt: directUpdatedAt }
    : null;

  const resolved = resolveMetadataStringOverrideV1(metadata ?? null, 'modelOverrideV1', 'modelId');
  const fromOverride = resolved && resolved.value !== 'default'
    ? { source: 'persisted' as const, value: resolved.value, updatedAt: resolved.updatedAt }
    : null;

  const chosen = chooseTimestamped([direct, fromOverride]);
  return chosen ? { source: 'persisted', ...chosen } : null;
}

function chooseVendorResumeId(params: ResolveSessionRuntimeSnapshotParams): SessionRuntimeSnapshot['vendorResumeId'] {
  const metadata = params.persistedMetadata ?? null;
  const incomingResume = normalizeNonEmptyString(params.incomingOptions.resume);
  if (incomingResume) {
    return { value: incomingResume, updatedAt: null };
  }
  if (params.incomingOptions.backendTarget?.kind === 'configuredAcpBackend') {
    return null;
  }
  const agentId =
    readAgentIdFromOptions(params.incomingOptions)
    ?? readAgentIdFromOptions(params.trackedSpawnOptions)
    ?? inferAgentIdFromSessionMetadata(metadata);
  const metadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
  const value =
    normalizeNonEmptyString(params.trackedSpawnOptions?.resume)
    ?? normalizeNonEmptyString(params.trackedVendorResumeId)
    ?? normalizeNonEmptyString(params.persistedVendorResumeId)
    ?? normalizeNonEmptyString(metadataVendorResumeId);
  return value ? { value, updatedAt: null } : null;
}

function applySnapshotToSpawnOptions(
  options: SpawnSessionOptions,
  snapshot: SessionRuntimeSnapshot,
): SpawnSessionOptions {
  // The snapshot's spawn options are the DURABLE respawn/resume identity (persisted as tracked
  // spawn options and replayed by crash/auth respawns). One-shot delivery fields from a single
  // resume RPC must not survive into it: a stale `initialTranscriptAfterSeq` makes every later
  // respawn replay already-processed user messages through the explicit startup catch-up
  // (incident: session cmq7pyqkj, 2026-06-12); stale prompts/goals/attach payloads are equally
  // single-use.
  const {
    initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
    executionAuthorization: _executionAuthorization,
    pendingFirstInput: _pendingFirstInput,
    initialGoal: _initialGoal,
    existingSessionAttachPayload: _existingSessionAttachPayload,
    ...durableOptions
  } = options;
  const next: SpawnSessionOptions = { ...durableOptions };

  if (snapshot.connectedServices) {
    next.connectedServices = snapshot.connectedServices;
    if (snapshot.connectedServicesUpdatedAt !== null) {
      next.connectedServicesUpdatedAt = snapshot.connectedServicesUpdatedAt;
    }
  }

  if (snapshot.connectedServiceMaterializationIdentityV1) {
    next.connectedServiceMaterializationIdentityV1 = snapshot.connectedServiceMaterializationIdentityV1;
  }

  if (snapshot.mcpSelection) {
    next.mcpSelection = snapshot.mcpSelection;
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
      params.trackedSpawnOptions?.connectedServicesUpdatedAt,
      'tracked',
    ),
    readConnectedServicesCandidate(
      params.incomingOptions.connectedServices,
      params.incomingOptions.connectedServicesUpdatedAt,
      'incoming',
    ),
  ]);

  const snapshot: SessionRuntimeSnapshot = {
    sessionId: readSessionId(params.incomingOptions),
    connectedServices: connectedServices?.value ?? null,
    connectedServicesUpdatedAt: connectedServices?.updatedAt ?? null,
    connectedServiceMaterializationIdentityV1: chooseMaterializationIdentityCandidate([
      readMaterializationIdentityCandidate(params.persistedMetadata?.connectedServiceMaterializationIdentityV1),
      readMaterializationIdentityCandidate(params.trackedSpawnOptions?.connectedServiceMaterializationIdentityV1),
      readMaterializationIdentityFromOptionsEnv(params.trackedSpawnOptions),
      readMaterializationIdentityCandidate(params.incomingOptions.connectedServiceMaterializationIdentityV1),
    ])?.value ?? null,
    // Session metadata is the canonical owner after creation. Incoming/tracked
    // options are only fallbacks for a new Session or an older snapshot.
    mcpSelection:
      parseMcpSelection(params.persistedMetadata?.mcpSelectionV1)
      ?? parseMcpSelection(params.incomingOptions.mcpSelection)
      ?? parseMcpSelection(params.trackedSpawnOptions?.mcpSelection),
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
