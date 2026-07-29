import {
  ProviderConnectionIdSchema,
  ProviderCatalogFingerprintV1Schema,
  ProviderMachineIdSchema,
  ProviderModelIdSchema,
  ProviderObservationAuthorizationFingerprintV1Schema,
  createProviderErrorV1,
  type ProviderErrorV1,
  type ProviderCatalogRuntimeStateRecordV1,
  type ProviderRuntimeStateFileV1,
} from '@happier-dev/protocol';

import {
  createProviderCatalogRefreshFingerprint,
  type ProviderCatalogRefreshResult,
} from '../probe/catalog';
import type { ResolvedProviderProbeRpcRequest } from '../probe/rpc';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import type {
  ProviderCurrentModelObservation,
  ProviderModelLoadCatalogPort,
} from './load';

type ModelLoadResolvedCatalogRequest = ResolvedProviderProbeRpcRequest;

function unavailable(connectionId: string, machineId: string): ProviderCurrentModelObservation {
  return {
    status: 'error',
    error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId, machineId }),
  };
}

/** Canonical current-record selector shared by model listing and loading. */
export function selectCurrentProviderCatalogRuntimeRecord(input: Readonly<{
  state: ProviderRuntimeStateFileV1;
  machineId: string;
  connectionId: string;
  catalogFingerprint: string;
  allowedObservationAuthorizationFingerprints: readonly string[];
}>): ProviderCatalogRuntimeStateRecordV1 | null {
  const machineId = ProviderMachineIdSchema.parse(input.machineId);
  const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
  const catalogFingerprint = ProviderCatalogFingerprintV1Schema.parse(input.catalogFingerprint);
  if (input.state.machineId !== machineId) {
    throw new TypeError('Provider runtime state belongs to another machine');
  }
  const allowed = new Set(input.allowedObservationAuthorizationFingerprints.map((fingerprint) =>
    ProviderObservationAuthorizationFingerprintV1Schema.parse(fingerprint)));
  if (allowed.size === 0) return null;
  const candidates = input.state.catalogs.filter((candidate) =>
    candidate.key.machineId === machineId
    && candidate.key.connectionId === connectionId
    && candidate.key.catalogFingerprint === catalogFingerprint
    && allowed.has(candidate.key.observationAuthorizationFingerprint)
    && candidate.state.snapshot !== null);
  candidates.sort((left, right) => {
    const observedDelta = right.state.snapshot!.observedAt - left.state.snapshot!.observedAt;
    if (observedDelta !== 0) return observedDelta;
    const leftId = 'catalogObservationId' in left.state ? left.state.catalogObservationId : '';
    const rightId = 'catalogObservationId' in right.state ? right.state.catalogObservationId : '';
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.key.observationAuthorizationFingerprint < right.key.observationAuthorizationFingerprint
      ? -1
      : left.key.observationAuthorizationFingerprint > right.key.observationAuthorizationFingerprint
        ? 1
        : 0;
  });
  return candidates[0] ?? null;
}

/**
 * Reads only the exact fresh catalog generation authorized for the current
 * endpoint/probe shape and SavedSecret observation fingerprint. It neither
 * merges catalogs nor guesses from stale/static/manual rows.
 */
export function readProviderModelLoadCatalogObservation(input: Readonly<{
  state: ProviderRuntimeStateFileV1;
  resolved: ModelLoadResolvedCatalogRequest;
  modelId: string;
}>): ProviderCurrentModelObservation {
  const connectionId = ProviderConnectionIdSchema.parse(input.resolved.connectionId);
  const machineId = ProviderMachineIdSchema.parse(input.resolved.machineId);
  const modelId = ProviderModelIdSchema.parse(input.modelId);
  if (input.state.machineId !== machineId || input.resolved.probes.length === 0) {
    return unavailable(connectionId, machineId);
  }
  const catalog = selectCurrentProviderCatalogRuntimeRecord({
    state: input.state,
    machineId,
    connectionId,
    catalogFingerprint: createProviderCatalogRefreshFingerprint(input.resolved),
    allowedObservationAuthorizationFingerprints:
      input.resolved.observationAuthorizationFingerprints,
  });
  if (!catalog) return unavailable(connectionId, machineId);
  if (!('catalogObservationId' in catalog.state)
    || catalog.state.snapshot.stale) {
    return unavailable(connectionId, machineId);
  }
  const catalogObservationId = catalog.state.catalogObservationId;
  if (!catalog.state.snapshot.models.some((candidate) => candidate.id === modelId)) {
    return { status: 'not_found' };
  }
  const loadMatches = input.state.modelLoadStates.filter((candidate) =>
    candidate.key.machineId === machineId
    && candidate.key.connectionId === connectionId
    && candidate.key.catalogObservationId === catalogObservationId
    && candidate.key.modelId === modelId);
  if (loadMatches.length > 1) return unavailable(connectionId, machineId);
  return {
    status: 'listed',
    catalogObservationId,
    loadState: loadMatches[0]?.loadState ?? 'unknown',
  };
}

export function createProviderModelLoadCatalogPort<TTicket>(dependencies: Readonly<{
  resolveSaved(input: Readonly<{
    connectionId: string;
    machineId: string;
  }>): Promise<ModelLoadResolvedCatalogRequest>;
  runtimeStore: Pick<ProviderRuntimeStateStore, 'read'>;
  /** Explicit scheduler-backed refresh; completed TTL entries must be bypassed. */
  refresh(input: ModelLoadResolvedCatalogRequest & Readonly<{
    modelId: string;
    refreshFrontier: string;
    signal: AbortSignal;
  }>): Promise<ProviderCatalogRefreshResult>;
}>): ProviderModelLoadCatalogPort<TTicket> {
  async function resolveExact(input: Readonly<{ connectionId: string; machineId: string }>) {
    const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
    const machineId = ProviderMachineIdSchema.parse(input.machineId);
    const resolved = await dependencies.resolveSaved({ connectionId, machineId });
    if (resolved.connectionId !== connectionId || resolved.machineId !== machineId) {
      throw new TypeError('Provider catalog resolver returned a different connection or machine');
    }
    return resolved;
  }

  return Object.freeze({
    async readCurrentModel(input) {
      const resolved = await resolveExact(input);
      const state = await dependencies.runtimeStore.read();
      return readProviderModelLoadCatalogObservation({ state, resolved, modelId: input.modelId });
    },
    async refresh(input) {
      let resolved: ModelLoadResolvedCatalogRequest;
      try {
        resolved = await resolveExact(input);
      } catch {
        const error: ProviderErrorV1 = createProviderErrorV1('provider_endpoint_unavailable', {
          connectionId: input.connectionId,
          machineId: input.machineId,
        });
        return { status: 'error', error };
      }
      return dependencies.refresh({
        ...resolved,
        modelId: ProviderModelIdSchema.parse(input.modelId),
        refreshFrontier: input.refreshFrontier,
        signal: input.signal,
      });
    },
  });
}
