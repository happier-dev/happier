import { z } from 'zod';

import {
  ProviderCatalogProbeModelV1Schema,
  ProviderCatalogSnapshotV1Schema,
} from '../catalog/merge.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from '../catalog/limits.js';
import {
  ProviderCatalogFingerprintV1Schema,
  ProviderEndpointObservationFingerprintV1Schema,
  ProviderObservationAuthorizationFingerprintV1Schema,
} from '../fingerprints.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import {
  ProviderConnectionIdSchema,
  ProviderContributionKeySchema,
  ProviderLocalIdSchema,
  ProviderMachineIdSchema,
  ProviderModelIdSchema,
} from '../ids.js';

export const PROVIDER_RUNTIME_STATE_LIMITS_V1 = Object.freeze({
  maxEndpointRecords: 8_192,
  maxCatalogRecords: 2_048,
  maxInstallationRecords: 4_096,
  maxCatalogModelIdentities: 50_000,
  maxModelLoadRecords: 50_000,
  maxEncodedBytes: 64 * 1024 * 1024,
  maxRetryDelayMs: 24 * 60 * 60 * 1_000,
} as const);

export const ProviderModelLoadStateV1Schema = z.enum(['loaded', 'unloaded', 'unknown']);
export type ProviderModelLoadStateV1 = z.infer<typeof ProviderModelLoadStateV1Schema>;
export const ProviderEndpointHealthStatusV1Schema = z.enum(['not_checked', 'available', 'unreachable', 'temporarily_unavailable', 'rate_limited', 'unauthorized', 'invalid_response']);
export type ProviderEndpointHealthStatusV1 = z.infer<typeof ProviderEndpointHealthStatusV1Schema>;
export const ProviderEndpointProbeActivityV1Schema = z.enum(['idle', 'checking']);
export type ProviderEndpointProbeActivityV1 = z.infer<typeof ProviderEndpointProbeActivityV1Schema>;
export const ProviderConnectionSummaryHealthV1Schema = z.enum(['not_checked', 'available', 'partial', 'needs_attention', 'unreachable']);
export type ProviderConnectionSummaryHealthV1 = z.infer<typeof ProviderConnectionSummaryHealthV1Schema>;

export const ProviderCatalogObservationIdV1Schema = z.string().min(1).max(256)
  .refine((value) => value === value.trim(), 'Catalog observation id must already be canonical')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Catalog observation id must not contain control characters');

export const ProviderEndpointRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  endpointTemplateId: ProviderLocalIdSchema,
  endpointFingerprint: ProviderEndpointObservationFingerprintV1Schema,
  observationAuthorizationFingerprint: ProviderObservationAuthorizationFingerprintV1Schema,
}).strict();
export type ProviderEndpointRuntimeStateKeyV1 = z.infer<typeof ProviderEndpointRuntimeStateKeyV1Schema>;

export const ProviderCatalogRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  catalogFingerprint: ProviderCatalogFingerprintV1Schema,
  observationAuthorizationFingerprint: ProviderObservationAuthorizationFingerprintV1Schema,
}).strict();
export type ProviderCatalogRuntimeStateKeyV1 = z.infer<typeof ProviderCatalogRuntimeStateKeyV1Schema>;

export const ProviderInstallationRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema.transform(
    canonicalizeProviderContributionKeyV1,
  ),
  checkId: ProviderLocalIdSchema,
}).strict();
export type ProviderInstallationRuntimeStateKeyV1 = z.infer<typeof ProviderInstallationRuntimeStateKeyV1Schema>;

export const ProviderModelLoadRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  catalogObservationId: ProviderCatalogObservationIdV1Schema,
  modelId: ProviderModelIdSchema,
}).strict();
export type ProviderModelLoadRuntimeStateKeyV1 = z.infer<typeof ProviderModelLoadRuntimeStateKeyV1Schema>;

function serializeEndpointKey(key: ProviderEndpointRuntimeStateKeyV1): string {
  return JSON.stringify([
    key.machineId,
    key.connectionId,
    key.endpointTemplateId,
    key.endpointFingerprint,
    key.observationAuthorizationFingerprint,
  ]);
}

function serializeCatalogKey(key: ProviderCatalogRuntimeStateKeyV1): string {
  return JSON.stringify([
    key.machineId,
    key.connectionId,
    key.catalogFingerprint,
    key.observationAuthorizationFingerprint,
  ]);
}

function serializeInstallationKey(key: ProviderInstallationRuntimeStateKeyV1): string {
  return JSON.stringify([key.machineId, key.contributionKey, key.checkId]);
}

function serializeModelLoadKey(key: ProviderModelLoadRuntimeStateKeyV1): string {
  return JSON.stringify([key.machineId, key.connectionId, key.catalogObservationId, key.modelId]);
}

export function serializeProviderEndpointRuntimeStateKeyV1(input: unknown): string {
  return serializeEndpointKey(ProviderEndpointRuntimeStateKeyV1Schema.parse(input));
}

export function serializeProviderCatalogRuntimeStateKeyV1(input: unknown): string {
  return serializeCatalogKey(ProviderCatalogRuntimeStateKeyV1Schema.parse(input));
}

export function serializeProviderInstallationRuntimeStateKeyV1(input: unknown): string {
  return serializeInstallationKey(ProviderInstallationRuntimeStateKeyV1Schema.parse(input));
}

export function serializeProviderModelLoadRuntimeStateKeyV1(input: unknown): string {
  return serializeModelLoadKey(ProviderModelLoadRuntimeStateKeyV1Schema.parse(input));
}

const RuntimeTimestampSchema = z.number().finite().nonnegative();
const observedStateShape = {
  activity: ProviderEndpointProbeActivityV1Schema,
  observedAt: RuntimeTimestampSchema,
  staleAt: RuntimeTimestampSchema.optional(),
} as const;

export const ProviderEndpointRuntimeStateV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('not_checked'),
    activity: ProviderEndpointProbeActivityV1Schema,
  }).strict(),
  z.object({
    status: z.literal('available'),
    ...observedStateShape,
  }).strict(),
  z.object({
    status: z.literal('unreachable'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_unreachable'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('temporarily_unavailable'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_unavailable'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('rate_limited'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_rate_limited'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('unauthorized'),
    ...observedStateShape,
    errorCode: z.enum(['provider_endpoint_auth_required', 'provider_endpoint_unauthorized']),
  }).strict(),
  z.object({
    status: z.literal('invalid_response'),
    ...observedStateShape,
    errorCode: z.literal('provider_probe_response_invalid'),
  }).strict(),
]).superRefine((value, ctx) => {
  if ('observedAt' in value && value.staleAt !== undefined && value.staleAt < value.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['staleAt'], message: 'Stale time cannot precede observation time' });
  }
  if ('observedAt' in value && 'retryAt' in value && value.retryAt !== undefined) {
    if (value.retryAt < value.observedAt) {
      ctx.addIssue({ code: 'custom', path: ['retryAt'], message: 'Retry time cannot precede observation time' });
    }
    if (value.retryAt - value.observedAt > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxRetryDelayMs) {
      ctx.addIssue({ code: 'custom', path: ['retryAt'], message: 'Retry time exceeds the maximum provider backoff' });
    }
  }
});
export type ProviderEndpointRuntimeStateV1 = z.infer<typeof ProviderEndpointRuntimeStateV1Schema>;

export const ProviderEndpointRuntimeStateRecordV1Schema = z.object({
  key: ProviderEndpointRuntimeStateKeyV1Schema,
  state: ProviderEndpointRuntimeStateV1Schema,
  lastAccessedAt: RuntimeTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if ('observedAt' in value.state && value.lastAccessedAt < value.state.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['lastAccessedAt'], message: 'Access time cannot precede observation time' });
  }
});
export type ProviderEndpointRuntimeStateRecordV1 = z.infer<typeof ProviderEndpointRuntimeStateRecordV1Schema>;

const EmptyCatalogRuntimeStateV1Schema = z.object({
  snapshot: z.null(),
  staleProbeModels: z.array(ProviderCatalogProbeModelV1Schema).length(0),
}).strict();
const ObservedCatalogRuntimeStateV1Schema = z.object({
  catalogObservationId: ProviderCatalogObservationIdV1Schema,
  snapshot: ProviderCatalogSnapshotV1Schema,
  staleProbeModels: z.array(ProviderCatalogProbeModelV1Schema)
    .max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
}).strict().superRefine((value, ctx) => {
  const activeIds = new Set(value.snapshot.models.map((model) => model.id));
  const staleIds = new Set<string>();
  value.staleProbeModels.forEach((model, index) => {
    if (activeIds.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['staleProbeModels', index, 'id'], message: 'Stale model is still active' });
    }
    if (staleIds.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['staleProbeModels', index, 'id'], message: 'Duplicate stale model id' });
    }
    staleIds.add(model.id);
  });
});
export const ProviderCatalogRuntimeStateV1Schema = z.union([
  EmptyCatalogRuntimeStateV1Schema,
  ObservedCatalogRuntimeStateV1Schema,
]);
export type ProviderCatalogRuntimeStateV1 = z.infer<typeof ProviderCatalogRuntimeStateV1Schema>;

export const ProviderCatalogRuntimeStateRecordV1Schema = z.object({
  key: ProviderCatalogRuntimeStateKeyV1Schema,
  state: ProviderCatalogRuntimeStateV1Schema,
  lastAccessedAt: RuntimeTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.state.snapshot && value.lastAccessedAt < value.state.snapshot.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['lastAccessedAt'], message: 'Access time cannot precede observation time' });
  }
});
export type ProviderCatalogRuntimeStateRecordV1 = z.infer<typeof ProviderCatalogRuntimeStateRecordV1Schema>;

export const ProviderInstallationRuntimeStateRecordV1Schema = z.object({
  key: ProviderInstallationRuntimeStateKeyV1Schema,
  state: z.object({
    status: z.enum(['present', 'absent']),
    observedAt: RuntimeTimestampSchema,
  }).strict(),
  lastAccessedAt: RuntimeTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.lastAccessedAt < value.state.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['lastAccessedAt'], message: 'Access time cannot precede observation time' });
  }
});
export type ProviderInstallationRuntimeStateRecordV1 = z.infer<typeof ProviderInstallationRuntimeStateRecordV1Schema>;

export const ProviderModelLoadRuntimeStateRecordV1Schema = z.object({
  key: ProviderModelLoadRuntimeStateKeyV1Schema,
  loadState: ProviderModelLoadStateV1Schema,
  observedAt: RuntimeTimestampSchema,
  lastAccessedAt: RuntimeTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.lastAccessedAt < value.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['lastAccessedAt'], message: 'Access time cannot precede observation time' });
  }
});
export type ProviderModelLoadRuntimeStateRecordV1 = z.infer<typeof ProviderModelLoadRuntimeStateRecordV1Schema>;

const ProviderRuntimeStateFileShapeV1Schema = z.object({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  endpointHealth: z.array(ProviderEndpointRuntimeStateRecordV1Schema)
    .max(PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEndpointRecords),
  catalogs: z.array(ProviderCatalogRuntimeStateRecordV1Schema)
    .max(PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogRecords),
  installationChecks: z.array(ProviderInstallationRuntimeStateRecordV1Schema)
    .max(PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords),
  modelLoadStates: z.array(ProviderModelLoadRuntimeStateRecordV1Schema)
    .max(PROVIDER_RUNTIME_STATE_LIMITS_V1.maxModelLoadRecords),
}).strict();
export type ProviderRuntimeStateFileV1 = z.infer<typeof ProviderRuntimeStateFileShapeV1Schema>;

type RuntimeStateSemanticIssue = Readonly<{
  reason: 'machine_mismatch' | 'duplicate_key' | 'limit_exceeded' | 'malformed';
  path: readonly (string | number)[];
  message: string;
}>;

function tupleKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function firstDuplicateKey<T>(values: readonly T[], key: (value: T) => string): number | null {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const serialized = key(values[index]!);
    if (seen.has(serialized)) return index;
    seen.add(serialized);
  }
  return null;
}

function validateRuntimeStateSemantics(value: ProviderRuntimeStateFileV1): RuntimeStateSemanticIssue | null {
  const childMachineRows: readonly Readonly<{ machineId: string; path: readonly (string | number)[] }>[] = [
    ...value.endpointHealth.map((record, index) => ({ machineId: record.key.machineId, path: ['endpointHealth', index, 'key', 'machineId'] })),
    ...value.catalogs.map((record, index) => ({ machineId: record.key.machineId, path: ['catalogs', index, 'key', 'machineId'] })),
    ...value.installationChecks.map((record, index) => ({ machineId: record.key.machineId, path: ['installationChecks', index, 'key', 'machineId'] })),
    ...value.modelLoadStates.map((record, index) => ({ machineId: record.key.machineId, path: ['modelLoadStates', index, 'key', 'machineId'] })),
  ];
  const mismatched = childMachineRows.find((row) => row.machineId !== value.machineId);
  if (mismatched) {
    return { reason: 'machine_mismatch', path: mismatched.path, message: 'Runtime-state child machine does not match the file envelope' };
  }

  const duplicateEndpoint = firstDuplicateKey(value.endpointHealth, (record) =>
    serializeEndpointKey(record.key));
  if (duplicateEndpoint !== null) {
    return { reason: 'duplicate_key', path: ['endpointHealth', duplicateEndpoint], message: 'Duplicate semantic runtime-state key' };
  }
  const duplicateCatalog = firstDuplicateKey(value.catalogs, (record) => serializeCatalogKey(record.key));
  if (duplicateCatalog !== null) {
    return { reason: 'duplicate_key', path: ['catalogs', duplicateCatalog], message: 'Duplicate semantic runtime-state key' };
  }
  const duplicateInstallation = firstDuplicateKey(value.installationChecks, (record) =>
    serializeInstallationKey(record.key));
  if (duplicateInstallation !== null) {
    return { reason: 'duplicate_key', path: ['installationChecks', duplicateInstallation], message: 'Duplicate semantic runtime-state key' };
  }
  const duplicateLoad = firstDuplicateKey(value.modelLoadStates, (record) => serializeModelLoadKey(record.key));
  if (duplicateLoad !== null) {
    return { reason: 'duplicate_key', path: ['modelLoadStates', duplicateLoad], message: 'Duplicate semantic runtime-state key' };
  }

  let catalogModelIdentities = 0;
  const catalogGenerations = new Map<string, ReadonlySet<string>>();
  for (let index = 0; index < value.catalogs.length; index += 1) {
    const record = value.catalogs[index]!;
    if (!('catalogObservationId' in record.state)) continue;
    const generationKey = tupleKey([
      record.key.machineId,
      record.key.connectionId,
      record.state.catalogObservationId,
    ]);
    if (catalogGenerations.has(generationKey)) {
      return {
        reason: 'duplicate_key',
        path: ['catalogs', index, 'state', 'catalogObservationId'],
        message: 'Catalog observation generation is ambiguous for this connection',
      };
    }
    const catalogIdentityIds = new Set([
      ...record.state.snapshot.models.map((model) => model.id),
      ...record.state.staleProbeModels.map((model) => model.id),
    ]);
    catalogModelIdentities += catalogIdentityIds.size;
    catalogGenerations.set(
      generationKey,
      new Set(record.state.snapshot.models.map((model) => model.id)),
    );
  }
  if (catalogModelIdentities > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogModelIdentities) {
    return { reason: 'limit_exceeded', path: ['catalogs'], message: 'Cached catalog identities exceed the runtime-state limit' };
  }

  for (let index = 0; index < value.modelLoadStates.length; index += 1) {
    const record = value.modelLoadStates[index]!;
    const generation = catalogGenerations.get(tupleKey([
      record.key.machineId,
      record.key.connectionId,
      record.key.catalogObservationId,
    ]));
    if (!generation || !generation.has(record.key.modelId)) {
      return {
        reason: 'malformed',
        path: ['modelLoadStates', index, 'key'],
        message: 'Model-load state must attach to an exact model in its catalog observation generation',
      };
    }
  }
  return null;
}

export const ProviderRuntimeStateFileV1Schema = ProviderRuntimeStateFileShapeV1Schema.superRefine((value, ctx) => {
  const issue = validateRuntimeStateSemantics(value);
  if (issue) ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes) {
    ctx.addIssue({ code: 'custom', message: 'Provider runtime-state file exceeds the encoded byte limit' });
  }
});

export type ProviderRuntimeStateParseFailureReasonV1 =
  | RuntimeStateSemanticIssue['reason']
  | 'future_version'
  | 'encoded_size_exceeded';

export type ProviderRuntimeStateParseResultV1 =
  | Readonly<{ ok: true; state: ProviderRuntimeStateFileV1 }>
  | Readonly<{
      ok: false;
      state: ProviderRuntimeStateFileV1;
      diagnostic: Readonly<{
        code: 'provider_runtime_state_invalid';
        reason: ProviderRuntimeStateParseFailureReasonV1;
      }>;
    }>;

export function createEmptyProviderRuntimeStateFileV1(machineId: string): ProviderRuntimeStateFileV1 {
  return {
    v: 1,
    machineId: ProviderMachineIdSchema.parse(machineId),
    endpointHealth: [],
    catalogs: [],
    installationChecks: [],
    modelLoadStates: [],
  };
}

function invalidRuntimeState(
  expectedMachineId: string,
  reason: ProviderRuntimeStateParseFailureReasonV1,
): ProviderRuntimeStateParseResultV1 {
  return {
    ok: false,
    state: createEmptyProviderRuntimeStateFileV1(expectedMachineId),
    diagnostic: { code: 'provider_runtime_state_invalid', reason },
  };
}

export function parseProviderRuntimeStateFileV1(
  input: unknown,
  options: Readonly<{ expectedMachineId: string; encodedBytes?: number }>,
): ProviderRuntimeStateParseResultV1 {
  const expectedMachineId = ProviderMachineIdSchema.parse(options.expectedMachineId);
  if (options.encodedBytes !== undefined) {
    if (!Number.isSafeInteger(options.encodedBytes) || options.encodedBytes < 0) {
      return invalidRuntimeState(expectedMachineId, 'malformed');
    }
    if (options.encodedBytes > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes) {
      return invalidRuntimeState(expectedMachineId, 'encoded_size_exceeded');
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalidRuntimeState(expectedMachineId, 'malformed');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.v === 'number' && Number.isInteger(raw.v) && raw.v > 1) {
    return invalidRuntimeState(expectedMachineId, 'future_version');
  }
  if (raw.v !== 1) return invalidRuntimeState(expectedMachineId, 'malformed');
  if (raw.machineId !== expectedMachineId) return invalidRuntimeState(expectedMachineId, 'machine_mismatch');

  const rawArrays = [
    ['endpointHealth', raw.endpointHealth, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEndpointRecords],
    ['catalogs', raw.catalogs, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxCatalogRecords],
    ['installationChecks', raw.installationChecks, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxInstallationRecords],
    ['modelLoadStates', raw.modelLoadStates, PROVIDER_RUNTIME_STATE_LIMITS_V1.maxModelLoadRecords],
  ] as const;
  for (const [, candidate, limit] of rawArrays) {
    if (!Array.isArray(candidate)) return invalidRuntimeState(expectedMachineId, 'malformed');
    if (candidate.length > limit) return invalidRuntimeState(expectedMachineId, 'limit_exceeded');
  }

  const parsed = ProviderRuntimeStateFileShapeV1Schema.safeParse(input);
  if (!parsed.success) return invalidRuntimeState(expectedMachineId, 'malformed');
  const semanticIssue = validateRuntimeStateSemantics(parsed.data);
  if (semanticIssue) return invalidRuntimeState(expectedMachineId, semanticIssue.reason);
  const encodedBytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
  if (encodedBytes > PROVIDER_RUNTIME_STATE_LIMITS_V1.maxEncodedBytes) {
    return invalidRuntimeState(expectedMachineId, 'encoded_size_exceeded');
  }
  return { ok: true, state: parsed.data };
}

export function normalizeProviderRuntimeStateFileForStartupV1(
  input: ProviderRuntimeStateFileV1,
): ProviderRuntimeStateFileV1 {
  const parsed = ProviderRuntimeStateFileV1Schema.parse(input);
  return {
    ...parsed,
    endpointHealth: parsed.endpointHealth.map((record) => ({
      ...record,
      state: { ...record.state, activity: 'idle' },
    })),
  };
}

export function deriveProviderConnectionSummaryHealthV1(
  states: readonly ProviderEndpointRuntimeStateV1[],
): ProviderConnectionSummaryHealthV1 {
  if (states.length === 0 || states.every((state) => state.status === 'not_checked')) return 'not_checked';
  if (states.every((state) => state.status === 'available')) return 'available';
  if (states.some((state) => state.status === 'available')) return 'partial';
  if (states.some((state) => ['rate_limited', 'unauthorized', 'invalid_response'].includes(state.status))) return 'needs_attention';
  if (states.some((state) => state.status === 'not_checked')) return 'not_checked';
  return 'unreachable';
}
