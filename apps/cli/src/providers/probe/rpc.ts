import { z } from 'zod';

import {
  PROVIDER_CATALOG_LIMITS_V1,
  ProviderObservationAuthorizationFingerprintV1Schema,
  ProviderConnectionIdSchema,
  ProviderMachineIdSchema,
  createProviderProbeObservationIdentityV1,
  createProviderErrorV1,
  type ProviderErrorV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderProbeObservationIdentityV1,
} from '@happier-dev/protocol';

import type {
  ProviderCatalogRefreshResult,
  ProviderManagedCatalogSource,
  ProviderProbeEndpoint,
} from './catalog';
import { createProviderCatalogRefreshFingerprint } from './catalog';
import {
  PROVIDER_PROBE_REFRESH_TRIGGERS,
  type ProviderProbeRefreshTrigger,
} from './scheduler';
import type { ProviderCatalogCommandFallbackV1, ProviderCatalogProbeV1 } from '@happier-dev/protocol';

const TriggerSchema = z.enum(PROVIDER_PROBE_REFRESH_TRIGGERS);
const SavedProbeRequestSchema = z.object({
  kind: z.literal('saved'),
  connectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
  trigger: TriggerSchema,
}).strict();
const ProbeRequestSchema = SavedProbeRequestSchema;

export type ResolvedProviderProbeRpcRequest = Readonly<{
  connectionId: string;
  machineId: string;
  endpoints: readonly ProviderProbeEndpoint[];
  probes: readonly ProviderCatalogProbeV1[];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  managedSource?: ProviderManagedCatalogSource;
  observationAuthorizationFingerprints: readonly z.infer<typeof ProviderObservationAuthorizationFingerprintV1Schema>[];
  authorizationGrant: Readonly<{
    kind: 'account' | 'machine';
    fingerprint: string;
    confirmedAt: number;
  }>;
}>;

export type ProviderSavedModelsRpcRow = Readonly<{
  id: string;
  name?: string;
  source: 'manual' | 'static' | 'probe';
  stale: boolean;
  loadState: 'loaded' | 'unloaded' | 'unknown';
  visibility: 'visible' | 'hidden_all_agents';
}>;

export type ProviderSavedModelsRpcResult =
  | Readonly<{
      status: 'success';
      connectionId: string;
      connectionRevision: number;
      manualModelPolicy: 'allowed' | 'catalog-only';
      modelLoadAction: 'available' | 'descriptor_absent' | 'feature_disabled';
      models: readonly ProviderSavedModelsRpcRow[];
    }>
  | Readonly<{ status: 'error'; error: ReturnType<typeof createProviderErrorV1> }>;

const SavedConnectionMachineRequestSchema = z.object({
  connectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
}).strict();

export class ProviderProbeRpcResolutionError extends Error {
  readonly error: ProviderErrorV1;

  constructor(error: ProviderErrorV1) {
    super(error.code);
    this.name = 'ProviderProbeRpcResolutionError';
    this.error = error;
  }
}

function canonicalAuthorizationFingerprints(
  resolved: ResolvedProviderProbeRpcRequest,
): readonly ProviderObservationAuthorizationFingerprintV1[] {
  const fingerprints = resolved.observationAuthorizationFingerprints
    .map((value) => ProviderObservationAuthorizationFingerprintV1Schema.parse(value))
    .sort();
  if (fingerprints.length > PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes) {
    throw new TypeError('Provider probe authorization fingerprint set exceeds the catalog probe limit');
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new TypeError('Provider probe authorization fingerprint set must be unique');
  }
  if (resolved.probes.length === 0 ? fingerprints.length !== 0 : fingerprints.length === 0) {
    throw new TypeError('Provider probe authorization fingerprints must match the resolved probe set');
  }
  return Object.freeze(fingerprints);
}

export function createResolvedProviderProbeObservationIdentity(
  resolved: ResolvedProviderProbeRpcRequest,
): ProviderProbeObservationIdentityV1 {
  return createProviderProbeObservationIdentityV1({
    machineId: resolved.machineId,
    connectionId: resolved.connectionId,
    catalogFingerprint: resolved.probes.length === 0
      ? null
      : createProviderCatalogRefreshFingerprint(resolved),
    observationAuthorizationFingerprints: canonicalAuthorizationFingerprints(resolved),
    authorizationGrant: resolved.authorizationGrant,
  });
}

export function createResolvedProviderProbeRunner(dependencies: Readonly<{
  refresh(input: ResolvedProviderProbeRpcRequest): Promise<ProviderCatalogRefreshResult>;
  schedule<T extends ProviderCatalogRefreshResult>(
    key: string,
    trigger: ProviderProbeRefreshTrigger,
    operation: () => Promise<T>,
  ): Promise<T>;
}>) {
  return (
    resolved: ResolvedProviderProbeRpcRequest,
    trigger: ProviderProbeRefreshTrigger,
  ): Promise<ProviderCatalogRefreshResult> => {
    const key = createResolvedProviderProbeObservationIdentity(resolved);
    return dependencies.schedule(key, trigger, () => dependencies.refresh(resolved));
  };
}

/**
 * Strict daemon boundary for persisted connections. Draft authoring uses the
 * same service through a separate one-shot authorization route; neither route
 * accepts plaintext credential material.
 */
export function createProviderProbeRpcHandler(dependencies: Readonly<{
  resolveSaved(input: Readonly<{ connectionId: string; machineId: string }>): Promise<ResolvedProviderProbeRpcRequest>;
  refresh(input: ResolvedProviderProbeRpcRequest): Promise<ProviderCatalogRefreshResult>;
  schedule<T extends ProviderCatalogRefreshResult>(
    key: string,
    trigger: ProviderProbeRefreshTrigger,
    operation: () => Promise<T>,
  ): Promise<T>;
}>) {
  const runResolved = createResolvedProviderProbeRunner(dependencies);
  return async (rawInput: unknown): Promise<ProviderCatalogRefreshResult> => {
    const input = ProbeRequestSchema.parse(rawInput);
    let resolved: ResolvedProviderProbeRpcRequest;
    try {
      resolved = await dependencies.resolveSaved({ connectionId: input.connectionId, machineId: input.machineId });
    } catch (error) {
      if (error instanceof ProviderProbeRpcResolutionError) {
        return { status: 'error', error: error.error };
      }
      throw error;
    }
    return runResolved(resolved, input.trigger);
  };
}

/**
 * Identity-only daemon boundary for a persisted connection probe. Endpoint,
 * probe, credential, and descriptor facts remain owned by the daemon service.
 */
export function createProviderSavedProbeRpcHandler(dependencies: Readonly<{
  machineId: string;
  probe(input: Readonly<{ connectionId: string; machineId: string }>): Promise<ProviderCatalogRefreshResult>;
}>) {
  const ownedMachineId = ProviderMachineIdSchema.parse(dependencies.machineId);
  return async (rawInput: unknown): Promise<ProviderCatalogRefreshResult> => {
    const input = SavedConnectionMachineRequestSchema.parse(rawInput);
    if (input.machineId !== ownedMachineId) {
      return {
        status: 'error',
        error: createProviderErrorV1('provider_not_enabled_on_machine', input),
      };
    }
    return dependencies.probe(input);
  };
}

/** Identity-only daemon boundary for the canonical merged model catalog. */
export function createProviderSavedModelsRpcHandler(dependencies: Readonly<{
  machineId: string;
  models(input: Readonly<{ connectionId: string; machineId: string }>): Promise<ProviderSavedModelsRpcResult>;
}>) {
  const ownedMachineId = ProviderMachineIdSchema.parse(dependencies.machineId);
  return async (rawInput: unknown): Promise<ProviderSavedModelsRpcResult> => {
    const input = SavedConnectionMachineRequestSchema.parse(rawInput);
    if (input.machineId !== ownedMachineId) {
      return {
        status: 'error',
        error: createProviderErrorV1('provider_not_enabled_on_machine', input),
      };
    }
    return dependencies.models(input);
  };
}
