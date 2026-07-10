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

export type ProviderCatalogSnapshotV1 = Readonly<{
  models: readonly ProviderCatalogProbeModelV1[];
  observedAt: number;
  stale: boolean;
}>;

export type ProviderCatalogRefreshV1 =
  | Readonly<{ status: 'success'; observedAt: number; models: readonly ProviderCatalogProbeModelV1[] }>
  | Readonly<{ status: 'failed' }>;

export type ProviderMergedCatalogRowV1 = Readonly<{
  descriptor: ProviderModelDescriptorV1;
  sources: Readonly<{ manual: boolean; static: boolean; probe: boolean }>;
  confidence: 'manual' | 'verified_static' | 'probe';
  catalogStale: boolean;
  stale?: true;
}>;

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
  previous: ProviderCatalogSnapshotV1 | null,
  refresh: ProviderCatalogRefreshV1,
): Readonly<{ snapshot: ProviderCatalogSnapshotV1 | null; disappearedModels: readonly ProviderCatalogProbeModelV1[] }> {
  let normalizedPrevious: ProviderCatalogSnapshotV1 | null = null;
  if (previous) {
    if (previous.models.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
      throw new ProviderCatalogLimitError('Previous provider catalog exceeds the per-connection model limit');
    }
    if (!Number.isFinite(previous.observedAt) || previous.observedAt < 0 || typeof previous.stale !== 'boolean') {
      throw new TypeError('Invalid previous provider catalog snapshot');
    }
    const models = previous.models.map((model) => ProviderCatalogProbeModelV1Schema.parse(model));
    assertUniqueModelIds(models, 'previous probe');
    normalizedPrevious = { models, observedAt: previous.observedAt, stale: previous.stale };
  }
  if (refresh.status === 'failed') {
    return {
      snapshot: normalizedPrevious ? { ...normalizedPrevious, stale: true } : null,
      disappearedModels: [],
    };
  }
  if (!Number.isFinite(refresh.observedAt) || refresh.observedAt < 0) throw new TypeError('Invalid catalog observation time');
  if (refresh.models.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Provider catalog exceeds the per-connection model limit');
  }
  const models = refresh.models.map((model) => ProviderCatalogProbeModelV1Schema.parse(model));
  assertUniqueModelIds(models, 'probe');
  const ids = new Set(models.map((model) => model.id));
  return {
    snapshot: { models, observedAt: refresh.observedAt, stale: false },
    disappearedModels: normalizedPrevious?.models.filter((model) => !ids.has(model.id)) ?? [],
  };
}

function probeDescriptor(model: ProviderCatalogProbeModelV1): ProviderModelDescriptorV1 {
  return { id: model.id, name: model.name ?? model.id };
}

export function mergeProviderCatalogV1(input: Readonly<{
  staticModels: readonly ProviderModelDescriptorV1[];
  manualModels: readonly ProviderManualModelV1[];
  probeSnapshot: ProviderCatalogSnapshotV1 | null;
  staleProbeModels: readonly ProviderCatalogProbeModelV1[];
}>): Readonly<{
  rows: readonly ProviderMergedCatalogRowV1[];
  staleRows: readonly ProviderMergedCatalogRowV1[];
}> {
  if (input.staticModels.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || input.manualModels.length > PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection
    || (input.probeSnapshot?.models.length ?? 0) > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    || input.staleProbeModels.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    throw new ProviderCatalogLimitError('Provider catalog source exceeds its model limit');
  }
  const staticModels = input.staticModels.map((model) => ProviderModelDescriptorV1Schema.parse(model));
  const manualModels = input.manualModels.map((model) => ProviderManualModelV1Schema.parse(model));
  const probeModels = input.probeSnapshot?.models.map((model) => ProviderCatalogProbeModelV1Schema.parse(model)) ?? [];
  const staleProbeModels = input.staleProbeModels.map((model) => ProviderCatalogProbeModelV1Schema.parse(model));
  assertUniqueModelIds(staticModels, 'static');
  assertUniqueModelIds(manualModels, 'manual');
  assertUniqueModelIds(probeModels, 'probe');
  assertUniqueModelIds(staleProbeModels, 'stale probe');

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
  const catalogStale = input.probeSnapshot?.stale ?? false;

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
