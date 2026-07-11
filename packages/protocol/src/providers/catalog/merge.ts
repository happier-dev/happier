import { z } from 'zod';

import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import type { ProviderManualModelV1 } from '../settings/v1.js';
import { PROVIDER_SETTINGS_LIMITS_V1, ProviderManualModelV1Schema } from '../settings/v1.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from './limits.js';

export const ProviderCatalogProbeModelV1Schema = z.object({
  id: ProviderModelDescriptorV1Schema.shape.id,
  name: ProviderModelDescriptorV1Schema.shape.name.optional(),
}).strict();
export type ProviderCatalogProbeModelV1 = z.infer<typeof ProviderCatalogProbeModelV1Schema>;

const ProviderRuntimeTimestampV1Schema = z.number().finite().nonnegative();
const ProviderCatalogProbeModelsV1Schema = z.array(ProviderCatalogProbeModelV1Schema)
  .max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection)
  .superRefine((models, ctx) => {
    const ids = new Set<string>();
    models.forEach((model, index) => {
      if (ids.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate probe model id' });
      }
      ids.add(model.id);
    });
  });

export const ProviderCatalogSnapshotV1Schema = z.discriminatedUnion('stale', [
  z.object({
    models: ProviderCatalogProbeModelsV1Schema,
    observedAt: ProviderRuntimeTimestampV1Schema,
    stale: z.literal(false),
  }).strict(),
  z.object({
    models: ProviderCatalogProbeModelsV1Schema,
    observedAt: ProviderRuntimeTimestampV1Schema,
    stale: z.literal(true),
    staleAt: ProviderRuntimeTimestampV1Schema,
  }).strict().superRefine((value, ctx) => {
    if (value.staleAt < value.observedAt) {
      ctx.addIssue({ code: 'custom', path: ['staleAt'], message: 'Catalog stale time cannot precede observation time' });
    }
  }),
]);
export type ProviderCatalogSnapshotV1 = z.infer<typeof ProviderCatalogSnapshotV1Schema>;

export const ProviderCatalogTransitionStateV1Schema = z.object({
  snapshot: ProviderCatalogSnapshotV1Schema.nullable(),
  staleProbeModels: z.array(ProviderCatalogProbeModelV1Schema)
    .max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
}).strict().superRefine((value, ctx) => {
  if (value.snapshot === null && value.staleProbeModels.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['staleProbeModels'], message: 'A missing catalog snapshot cannot retain stale models' });
  }
  const activeIds = new Set(value.snapshot?.models.map((model) => model.id) ?? []);
  const staleIds = new Set<string>();
  value.staleProbeModels.forEach((model, index) => {
    if (activeIds.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['staleProbeModels', index, 'id'], message: 'Stale models must be absent from the active snapshot' });
    }
    if (staleIds.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['staleProbeModels', index, 'id'], message: 'Duplicate stale probe model id' });
    }
    staleIds.add(model.id);
  });
});
export type ProviderCatalogTransitionStateV1 = z.infer<typeof ProviderCatalogTransitionStateV1Schema>;

export type ProviderCatalogRefreshV1 =
  | Readonly<{ status: 'success'; observedAt: number; models: readonly ProviderCatalogProbeModelV1[] }>
  | Readonly<{ status: 'failed'; failedAt: number }>;

export type ProviderMergedCatalogRowV1 = Readonly<{
  descriptor: ProviderModelDescriptorV1;
  sources: Readonly<{ manual: boolean; static: boolean; probe: boolean }>;
  confidence: 'manual' | 'verified_static' | 'probe';
  catalogStale: boolean;
  stale?: true;
}>;

export const ProviderMergedCatalogRowV1Schema = z.object({
  descriptor: ProviderModelDescriptorV1Schema,
  sources: z.object({ manual: z.boolean(), static: z.boolean(), probe: z.boolean() }).strict(),
  confidence: z.enum(['manual', 'verified_static', 'probe']),
  catalogStale: z.boolean(),
  stale: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.stale && !value.catalogStale) {
    ctx.addIssue({ code: 'custom', path: ['catalogStale'], message: 'Stale rows require stale catalog presentation' });
  }
}) satisfies z.ZodType<ProviderMergedCatalogRowV1>;

export class ProviderCatalogLimitError extends Error {
  readonly code = 'provider_catalog_limit_exceeded';
  constructor(message: string) { super(message); this.name = 'ProviderCatalogLimitError'; }
}

function assertUniqueModelIds(models: readonly { id: string }[], source: string): void {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new TypeError(`Duplicate ${source} model id`);
    ids.add(model.id);
  }
}

export function applyProviderCatalogRefreshV1(
  previous: ProviderCatalogTransitionStateV1,
  refresh: ProviderCatalogRefreshV1,
): ProviderCatalogTransitionStateV1 {
  if ((previous.snapshot?.models.length ?? 0) > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || previous.staleProbeModels.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Previous provider catalog exceeds the per-connection model limit');
  }
  const normalizedPrevious = ProviderCatalogTransitionStateV1Schema.parse(previous);
  if (refresh.status === 'failed') {
    if (!Number.isFinite(refresh.failedAt) || refresh.failedAt < 0) {
      throw new TypeError('Invalid catalog failure time');
    }
    if (normalizedPrevious.snapshot && refresh.failedAt < normalizedPrevious.snapshot.observedAt) {
      throw new TypeError('Catalog failure time cannot precede the retained observation');
    }
    return {
      snapshot: normalizedPrevious.snapshot
        ? {
          models: normalizedPrevious.snapshot.models,
          observedAt: normalizedPrevious.snapshot.observedAt,
          stale: true,
          staleAt: refresh.failedAt,
        }
        : null,
      staleProbeModels: normalizedPrevious.staleProbeModels,
    };
  }
  if (!Number.isFinite(refresh.observedAt) || refresh.observedAt < 0) throw new TypeError('Invalid catalog observation time');
  if (refresh.models.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Provider catalog exceeds the per-connection model limit');
  }
  const models = ProviderCatalogProbeModelsV1Schema.parse(refresh.models);
  const ids = new Set(models.map((model) => model.id));
  return {
    snapshot: { models, observedAt: refresh.observedAt, stale: false },
    staleProbeModels: normalizedPrevious.snapshot?.models.filter((model) => !ids.has(model.id)) ?? [],
  };
}

function probeDescriptor(model: ProviderCatalogProbeModelV1): ProviderModelDescriptorV1 {
  return { id: model.id, name: model.name ?? model.id };
}

export function mergeProviderCatalogV1(input: Readonly<{
  staticModels: readonly ProviderModelDescriptorV1[];
  manualModels: readonly ProviderManualModelV1[];
  probeState: ProviderCatalogTransitionStateV1;
}>): Readonly<{
  rows: readonly ProviderMergedCatalogRowV1[];
  staleRows: readonly ProviderMergedCatalogRowV1[];
}> {
  if (input.staticModels.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || input.manualModels.length > PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection
    || (input.probeState.snapshot?.models.length ?? 0) > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || input.probeState.staleProbeModels.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Provider catalog source exceeds its model limit');
  }
  const staticModels = input.staticModels.map((model) => ProviderModelDescriptorV1Schema.parse(model));
  const manualModels = input.manualModels.map((model) => ProviderManualModelV1Schema.parse(model));
  const probeState = ProviderCatalogTransitionStateV1Schema.parse(input.probeState);
  const probeModels = probeState.snapshot?.models ?? [];
  const staleProbeModels = probeState.staleProbeModels;
  assertUniqueModelIds(staticModels, 'static');
  assertUniqueModelIds(manualModels, 'manual');

  const uniqueIds = new Set([
    ...staticModels.map((model) => model.id),
    ...manualModels.map((model) => model.id),
    ...probeModels.map((model) => model.id),
  ]);
  if (uniqueIds.size > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Merged provider catalog exceeds the per-connection model limit');
  }

  const manualById = new Map(manualModels.map((model) => [model.id, model]));
  const staticById = new Map(staticModels.map((model) => [model.id, model]));
  const probeById = new Map(probeModels.map((model) => [model.id, model]));
  const rows: ProviderMergedCatalogRowV1[] = [];
  const emitted = new Set<string>();
  const catalogStale = probeState.snapshot?.stale ?? false;

  const emit = (id: string, descriptor: ProviderModelDescriptorV1, confidence: ProviderMergedCatalogRowV1['confidence']) => {
    const manual = manualById.get(id);
    rows.push({
      descriptor: manual?.name ? { ...descriptor, name: manual.name } : descriptor,
      sources: { manual: Boolean(manual), static: staticById.has(id), probe: probeById.has(id) },
      confidence,
      catalogStale,
    });
    emitted.add(id);
  };

  for (const model of staticModels) emit(model.id, model, 'verified_static');
  const remainingManual = manualModels.filter((model) => !emitted.has(model.id)).sort((a, b) =>
    a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const model of remainingManual) emit(model.id, { id: model.id, name: model.name ?? model.id }, 'manual');
  const remainingProbe = probeModels.filter((model) => !emitted.has(model.id)).sort((a, b) => {
    const aName = (a.name ?? a.id).toLowerCase();
    const bName = (b.name ?? b.id).toLowerCase();
    if (aName !== bName) return aName < bName ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const model of remainingProbe) emit(model.id, probeDescriptor(model), 'probe');

  const staleRows: ProviderMergedCatalogRowV1[] = [];
  for (const model of staleProbeModels) {
    if (emitted.has(model.id)) continue;
    staleRows.push({
      descriptor: probeDescriptor(model),
      sources: { manual: false, static: false, probe: true },
      confidence: 'probe',
      catalogStale: true,
      stale: true,
    });
  }
  return { rows, staleRows };
}

export type ProviderCatalogReferenceResolutionV1 =
  | Readonly<{ status: 'listed'; row: ProviderMergedCatalogRowV1 }>
  | Readonly<{
      status: 'not_currently_listed';
      descriptor: Readonly<{ id: string; name: string }>;
      provenance: 'stale_catalog' | 'display_snapshot' | 'model_id';
    }>
  | Readonly<{ status: 'not_found'; errorCode: 'provider_model_not_found' }>;

export function resolveProviderCatalogReferenceV1(input: Readonly<{
  modelId: string;
  activeRows: readonly ProviderMergedCatalogRowV1[];
  staleRows: readonly ProviderMergedCatalogRowV1[];
  manualModelPolicy: 'allowed' | 'catalog-only';
  agentSupportsFreeformModelIds: boolean;
  displaySnapshot?: Readonly<{ name: string }>;
}>): ProviderCatalogReferenceResolutionV1 {
  if (input.activeRows.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || input.staleRows.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Provider catalog reference inputs exceed their model limit');
  }
  const modelId = ProviderModelDescriptorV1Schema.shape.id.parse(input.modelId);
  const manualModelPolicy = z.enum(['allowed', 'catalog-only']).parse(input.manualModelPolicy);
  const agentSupportsFreeformModelIds = z.boolean().parse(input.agentSupportsFreeformModelIds);
  const activeRows = input.activeRows.map((row) => ProviderMergedCatalogRowV1Schema.parse(row));
  const staleRows = input.staleRows.map((row) => ProviderMergedCatalogRowV1Schema.parse(row));
  if (activeRows.some((row) => row.stale === true)) {
    throw new TypeError('An active row cannot carry stale-row identity');
  }
  if (staleRows.some((row) => row.stale !== true)) {
    throw new TypeError('A stale row must carry stale-row identity');
  }
  assertUniqueModelIds(activeRows.map((row) => row.descriptor), 'active catalog row');
  assertUniqueModelIds(staleRows.map((row) => row.descriptor), 'stale catalog row');
  const activeIds = new Set(activeRows.map((row) => row.descriptor.id));
  if (staleRows.some((row) => activeIds.has(row.descriptor.id))) {
    throw new TypeError('A provider model cannot be both active and stale');
  }
  const active = activeRows.find((row) => row.descriptor.id === modelId);
  if (active) return { status: 'listed', row: active };
  if (manualModelPolicy !== 'allowed' || !agentSupportsFreeformModelIds) {
    return { status: 'not_found', errorCode: 'provider_model_not_found' };
  }
  const stale = staleRows.find((row) => row.descriptor.id === modelId);
  if (stale) {
    return {
      status: 'not_currently_listed',
      descriptor: { id: modelId, name: stale.descriptor.name },
      provenance: 'stale_catalog',
    };
  }
  const displaySnapshot = input.displaySnapshot === undefined
    ? undefined
    : z.object({ name: ProviderModelDescriptorV1Schema.shape.name }).strict().parse(input.displaySnapshot);
  return {
    status: 'not_currently_listed',
    descriptor: { id: modelId, name: displaySnapshot?.name ?? modelId },
    provenance: displaySnapshot ? 'display_snapshot' : 'model_id',
  };
}
