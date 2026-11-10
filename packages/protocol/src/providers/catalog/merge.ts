import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { ProviderModelDescriptorV1Schema, resolveModelDisplayName } from '../../models/descriptor.js';
import type { ProviderManualModelV1 } from '../settings/v1.js';
import { ProviderManualModelV1Schema } from '../settings/v1.js';
import {
  ProviderCatalogMembershipPolicyV1Schema,
  type ProviderCatalogMembershipPolicyV1,
} from './descriptorV1.js';
import { QualifiedConnectedAccountPurposeV1Schema, type QualifiedConnectedAccountPurposeV1 } from '../../connect/connectedAccountPurposeIdentity.js';
import { qualifiedPurposeKey } from '../../connect/connectedAccountPurposeBindings.js';
import { PROVIDER_REASONING_EFFORT_OPTION_ID, buildProviderReasoningModelOptions } from './reasoningEffort.js';
import type { AgentModelOption } from '../../models/descriptor.js';

const ConnectedAccountPurposesSchema = z.array(QualifiedConnectedAccountPurposeV1Schema).check(z.superRefine((purposes, ctx) => {
  const keys = purposes.map(qualifiedPurposeKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Model purposes must be unique' });
}));

export type ProviderCatalogProbeModelV1 = Readonly<{
  id: ProviderModelDescriptorV1['id'];
  name?: ProviderModelDescriptorV1['name'];
  contextWindowTokens?: ProviderModelDescriptorV1['contextWindowTokens'];
  modelOptions?: ProviderModelDescriptorV1['modelOptions'];
  capabilities?: ProviderModelDescriptorV1['capabilities'];
  /** Producer-observed upstream slots; downstream protocol/model names are not vendor evidence. */
  connectedAccountPurposes?: readonly QualifiedConnectedAccountPurposeV1[];
}>;

export const ProviderCatalogProbeModelV1Schema = z.strictObject({
  id: ProviderModelDescriptorV1Schema.shape.id,
  name: z.optional(ProviderModelDescriptorV1Schema.shape.name),
  contextWindowTokens: ProviderModelDescriptorV1Schema.shape.contextWindowTokens,
  modelOptions: ProviderModelDescriptorV1Schema.shape.modelOptions,
  capabilities: ProviderModelDescriptorV1Schema.shape.capabilities,
  connectedAccountPurposes: z.optional(ConnectedAccountPurposesSchema),
}) satisfies z.ZodMiniType<ProviderCatalogProbeModelV1>;

const ProviderRuntimeTimestampV1Schema = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const ProviderCatalogProbeModelsV1Schema = lazyZodSchema(() => z.array(ProviderCatalogProbeModelV1Schema).check(z.superRefine((models, ctx) => {
    const ids = new Set<string>();
    models.forEach((model, index) => {
      if (ids.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate probe model id' });
      }
      ids.add(model.id);
    });
  })));

export const ProviderCatalogSnapshotV1Schema = lazyZodSchema(() => z.discriminatedUnion('stale', [
  z.strictObject({
    models: ProviderCatalogProbeModelsV1Schema,
    observedAt: ProviderRuntimeTimestampV1Schema,
    stale: z.literal(false),
  }),
  z.strictObject({
    models: ProviderCatalogProbeModelsV1Schema,
    observedAt: ProviderRuntimeTimestampV1Schema,
    stale: z.literal(true),
    staleAt: ProviderRuntimeTimestampV1Schema,
  }).check(z.superRefine((value, ctx) => {
    if (value.staleAt < value.observedAt) {
      ctx.addIssue({ code: 'custom', path: ['staleAt'], message: 'Catalog stale time cannot precede observation time' });
    }
  })),
]));
export type ProviderCatalogSnapshotV1 = z.infer<typeof ProviderCatalogSnapshotV1Schema>;

export const ProviderCatalogTransitionStateV1Schema = lazyZodSchema(() => z.strictObject({
  snapshot: z.nullable(ProviderCatalogSnapshotV1Schema),
  staleProbeModels: z.array(ProviderCatalogProbeModelV1Schema),
}).check(z.superRefine((value, ctx) => {
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
})));
export type ProviderCatalogTransitionStateV1 = z.infer<typeof ProviderCatalogTransitionStateV1Schema>;

export type ProviderCatalogRefreshV1 =
  | Readonly<{ status: 'success'; observedAt: number; models: readonly ProviderCatalogProbeModelV1[] }>
  | Readonly<{ status: 'failed'; failedAt: number }>;

export type ProviderMergedCatalogRowV1 = Readonly<{
  descriptor: ProviderModelDescriptorV1;
  sources: Readonly<{ manual: boolean; static: boolean; probe: boolean }>;
  confidence: 'manual' | 'verified_static' | 'probe' | 'account_unverified';
  catalogStale: boolean;
  stale?: true;
  connectedAccountPurposes?: readonly QualifiedConnectedAccountPurposeV1[];
}>;

export const ProviderMergedCatalogRowV1Schema = z.strictObject({
  descriptor: ProviderModelDescriptorV1Schema,
  sources: z.strictObject({ manual: z.boolean(), static: z.boolean(), probe: z.boolean() }),
  confidence: z.enum(['manual', 'verified_static', 'probe', 'account_unverified']),
  catalogStale: z.boolean(),
  stale: z.optional(z.literal(true)),
  connectedAccountPurposes: z.optional(ConnectedAccountPurposesSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.stale && !value.catalogStale) {
    ctx.addIssue({ code: 'custom', path: ['catalogStale'], message: 'Stale rows require stale catalog presentation' });
  }
})) satisfies z.ZodMiniType<ProviderMergedCatalogRowV1>;

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
  const models = ProviderCatalogProbeModelsV1Schema.parse(refresh.models);
  const ids = new Set(models.map((model) => model.id));
  return {
    snapshot: { models, observedAt: refresh.observedAt, stale: false },
    staleProbeModels: normalizedPrevious.snapshot?.models.filter((model) => !ids.has(model.id)) ?? [],
  };
}

/** Project catalog evidence into the strict Agent-facing model contract. */
export function projectProviderCatalogProbeModelDescriptorV1(model: ProviderCatalogProbeModelV1): ProviderModelDescriptorV1 {
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(model.modelOptions ? { modelOptions: model.modelOptions } : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  };
}

function authoritativeProbeDescriptor(
  probe: ProviderCatalogProbeModelV1,
  curated: ProviderModelDescriptorV1 | undefined,
): ProviderModelDescriptorV1 {
  const descriptor = projectProviderCatalogProbeModelDescriptorV1(probe);
  if (!curated) return descriptor;
  return {
    ...descriptor,
    name: curated.name,
    ...(curated.description === undefined ? {} : { description: curated.description }),
  };
}

export function mergeProviderCatalogV1(input: Readonly<{
  staticModels: readonly ProviderModelDescriptorV1[];
  manualModels: readonly ProviderManualModelV1[];
  probeState: ProviderCatalogTransitionStateV1;
  probeConfidence?: 'probe' | 'account_unverified';
  membershipPolicy?: ProviderCatalogMembershipPolicyV1;
  /** Display facts only; these models do not establish membership or runtime capabilities. */
  modelNameCatalog?: readonly ProviderModelDescriptorV1[];
}>): Readonly<{
  rows: readonly ProviderMergedCatalogRowV1[];
  staleRows: readonly ProviderMergedCatalogRowV1[];
}> {
  const staticModels = input.staticModels.map((model) => ProviderModelDescriptorV1Schema.parse(model));
  const manualModels = input.manualModels.map((model) => ProviderManualModelV1Schema.parse(model));
  const probeState = ProviderCatalogTransitionStateV1Schema.parse(input.probeState);
  const probeModels = probeState.snapshot?.models ?? [];
  const staleProbeModels = probeState.staleProbeModels;
  const membershipPolicy = ProviderCatalogMembershipPolicyV1Schema.parse(
    input.membershipPolicy ?? 'augment',
  );
  const probeOwnsMembership = membershipPolicy === 'probe-authoritative'
    && probeState.snapshot !== null;
  assertUniqueModelIds(staticModels, 'static');
  assertUniqueModelIds(manualModels, 'manual');

  const manualById = new Map(manualModels.map((model) => [model.id, model]));
  const staticById = new Map(staticModels.map((model) => [model.id, model]));
  const modelNameCatalog = [...staticModels, ...(input.modelNameCatalog ?? [])];
  const probeById = new Map(probeModels.map((model) => [model.id, model]));
  const rows: ProviderMergedCatalogRowV1[] = [];
  const emitted = new Set<string>();
  const catalogStale = probeState.snapshot?.stale ?? false;

  const emit = (id: string, descriptor: ProviderModelDescriptorV1, confidence: ProviderMergedCatalogRowV1['confidence']) => {
    const manual = manualById.get(id);
    if (manual?.reasoningEffortLevels) {
      // Explicit source facts (including unsupported) outrank a user's declaration.
      // Dependent controls travel with their reasoning option, never with a losing source.
      const isReasoningOption = (option: AgentModelOption) => option.id === PROVIDER_REASONING_EFFORT_OPTION_ID
        || option.overridesWhenOn?.optionIds.includes(PROVIDER_REASONING_EFFORT_OPTION_ID) === true;
      const source = [probeById.get(id), staticById.get(id)].find(model => model
        && (model.capabilities?.reasoningControls !== undefined || model.modelOptions?.some(isReasoningOption)));
      const reasoningControls = source ? source.capabilities?.reasoningControls : 'supported';
      const { reasoningControls: _previous, ...otherCapabilities } = descriptor.capabilities ?? {};
      descriptor = {
        ...descriptor,
        capabilities: { ...otherCapabilities, ...(reasoningControls === undefined ? {} : { reasoningControls }) },
        modelOptions: [
          ...(descriptor.modelOptions?.filter(option => !isReasoningOption(option)) ?? []),
          ...(source ? source.modelOptions?.filter(isReasoningOption) ?? []
            : buildProviderReasoningModelOptions({ supportedLevels: manual.reasoningEffortLevels })),
        ],
      };
    }
    rows.push({
      descriptor: { ...descriptor, name: manual?.name ?? resolveModelDisplayName(descriptor, modelNameCatalog) },
      sources: { manual: Boolean(manual), static: staticById.has(id), probe: probeById.has(id) },
      confidence,
      catalogStale,
      ...(probeById.get(id)?.connectedAccountPurposes ? { connectedAccountPurposes: probeById.get(id)!.connectedAccountPurposes } : {}),
    });
    emitted.add(id);
  };

  const sortedManual = [...manualModels].sort((a, b) =>
    a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedProbe = [...probeModels].sort((a, b) => {
    const aName = (a.name ?? a.id).toLowerCase();
    const bName = (b.name ?? b.id).toLowerCase();
    if (aName !== bName) return aName < bName ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const probeConfidence = input.probeConfidence ?? 'probe';
  if (probeOwnsMembership) {
    for (const model of sortedManual.filter((candidate) => !probeById.has(candidate.id))) {
      emit(model.id, { id: model.id, name: model.name ?? model.id }, 'manual');
    }
    for (const model of sortedProbe) {
      emit(
        model.id,
        authoritativeProbeDescriptor(model, staticById.get(model.id)),
        probeConfidence,
      );
    }
  } else {
    for (const model of staticModels) emit(model.id, model, 'verified_static');
    for (const model of sortedManual.filter((candidate) => !emitted.has(candidate.id))) {
      emit(model.id, { id: model.id, name: model.name ?? model.id }, 'manual');
    }
    for (const model of sortedProbe.filter((candidate) => !emitted.has(candidate.id))) {
      emit(model.id, projectProviderCatalogProbeModelDescriptorV1(model), probeConfidence);
    }
  }

  const staleRows: ProviderMergedCatalogRowV1[] = [];
  for (const model of staleProbeModels) {
    if (emitted.has(model.id)) continue;
    const descriptor = probeOwnsMembership
      ? authoritativeProbeDescriptor(model, staticById.get(model.id))
      : projectProviderCatalogProbeModelDescriptorV1(model);
    staleRows.push({
      descriptor: { ...descriptor, name: resolveModelDisplayName(descriptor, modelNameCatalog) },
      sources: { manual: false, static: staticById.has(model.id), probe: true },
      confidence: probeConfidence,
      catalogStale: true,
      stale: true,
      ...(model.connectedAccountPurposes ? { connectedAccountPurposes: model.connectedAccountPurposes } : {}),
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

/**
 * The two-sided freeform policy: whether a model id the catalog does not list is
 * still a real selection for this Provider and Agent pair.
 *
 * Both sides must permit it — the Provider by allowing manual ids, the Agent by
 * accepting ids it cannot verify against a catalog. Every owner that decides
 * whether an unlisted Provider model exists consumes this, so catalog membership
 * never becomes a second, stricter authority.
 */
export function providerCatalogPermitsUnlistedModelIdV1(input: Readonly<{
  manualModelPolicy: 'allowed' | 'catalog-only';
  agentSupportsFreeformModelIds: boolean;
}>): boolean {
  return input.manualModelPolicy === 'allowed' && input.agentSupportsFreeformModelIds;
}

export function resolveProviderCatalogReferenceV1(input: Readonly<{
  modelId: string;
  activeRows: readonly ProviderMergedCatalogRowV1[];
  staleRows: readonly ProviderMergedCatalogRowV1[];
  manualModelPolicy: 'allowed' | 'catalog-only';
  agentSupportsFreeformModelIds: boolean;
  displaySnapshot?: Readonly<{ name: string }>;
}>): ProviderCatalogReferenceResolutionV1 {
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
  if (!providerCatalogPermitsUnlistedModelIdV1({ manualModelPolicy, agentSupportsFreeformModelIds })) {
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
    : z.strictObject({ name: ProviderModelDescriptorV1Schema.shape.name }).parse(input.displaySnapshot);
  return {
    status: 'not_currently_listed',
    descriptor: { id: modelId, name: displaySnapshot?.name ?? modelId },
    provenance: displaySnapshot ? 'display_snapshot' : 'model_id',
  };
}
