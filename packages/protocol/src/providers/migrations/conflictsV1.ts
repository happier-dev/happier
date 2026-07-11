import { z } from 'zod';

import { createProviderFingerprintV1 } from '../fingerprints.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../ids.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import { readProviderSettingsFromAccountSettingsV1 } from '../settings/readFromAccountSettingsV1.js';
import type {
  ProviderSettingsMigrationConflictKindV1,
  ProviderSettingsMigrationModelChoiceV1,
  ProviderSettingsMigrationPendingConflictV1,
} from '../settings/v1.js';
import { ProviderMigrationSourceProfileIdSchema } from '../settings/v1.js';
import type {
  ProviderAccountSettingsMigrationCandidateV1,
  ProviderAccountSettingsMigrationContextV1,
} from './accountSettingsV1.js';

type ConnectionCandidate = Extract<ProviderAccountSettingsMigrationCandidateV1, { kind: 'connection' }>;

const LegacyProfileConflictFingerprintV1Schema = z.string()
  .startsWith('legacy-profile-migration-conflict:v1:')
  .max(256);

export const LegacyProfileMigrationConflictResolutionV1Schema = z.object({
  sourceProfileId: ProviderMigrationSourceProfileIdSchema,
  expectedCandidateFingerprint: LegacyProfileConflictFingerprintV1Schema,
  decision: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('keep_existing'),
      existingConnectionId: ProviderConnectionIdSchema,
      modelSelection: z.object({
        agentTargetKey: ProviderAgentTargetKeySchema,
        modelId: ProviderModelIdSchema,
      }).strict().nullable().optional(),
    }).strict(),
    z.object({
      kind: z.literal('create_named'),
      connectionId: ProviderConnectionIdSchema,
      displayName: z.string().trim().min(1).max(128),
    }).strict(),
  ]),
}).strict();
export type LegacyProfileMigrationConflictResolutionV1 = z.infer<
  typeof LegacyProfileMigrationConflictResolutionV1Schema
>;

function contributionKey(candidate: ConnectionCandidate): string | null {
  return candidate.connection.role === 'default' && candidate.connection.source.kind === 'contribution'
    ? candidate.connection.source.contributionKey
    : null;
}

function accountBindings(candidate: ConnectionCandidate): readonly [string, string][] {
  return Object.entries(candidate.secretBindings?.account ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function modelFacts(candidate: ConnectionCandidate): readonly Readonly<{ id: string; name: string | null }>[] {
  return (candidate.manualModels ?? [])
    .map((model) => ({ id: model.id, name: model.name ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function legacyModelChoice(candidate: ConnectionCandidate): ProviderSettingsMigrationModelChoiceV1 | null {
  if (!candidate.selectedModel) return null;
  const label = candidate.manualModels?.find((model) => model.id === candidate.selectedModel?.modelId)?.name;
  return {
    kind: 'legacy',
    selection: candidate.selectedModel,
    ...(label ? { label } : {}),
  };
}

function pairConflictKinds(left: ConnectionCandidate, right: ConnectionCandidate): ProviderSettingsMigrationConflictKindV1[] {
  const kinds = new Set<ProviderSettingsMigrationConflictKindV1>();
  const leftBindings = new Map(accountBindings(left));
  for (const [slot, secretId] of accountBindings(right)) {
    const prior = leftBindings.get(slot);
    if (prior !== undefined && prior !== secretId) kinds.add('credential_binding');
  }
  const leftModels = new Map(modelFacts(left).map((model) => [model.id, model.name] as const));
  for (const model of modelFacts(right)) {
    if (leftModels.has(model.id) && leftModels.get(model.id) !== model.name) kinds.add('manual_model');
  }
  if (left.selectedModel && right.selectedModel
    && (left.selectedModel.agentTargetKey !== right.selectedModel.agentTargetKey
      || left.selectedModel.modelId !== right.selectedModel.modelId)) {
    kinds.add('manual_model');
  }
  return [...kinds].sort();
}

function persistedWinnerConflict(input: Readonly<{
  candidate: ConnectionCandidate;
  winnerId: string;
  settings: ReturnType<typeof readProviderSettingsFromAccountSettingsV1>['settings'];
}>): Readonly<{
  kinds: ProviderSettingsMigrationConflictKindV1[];
  facts: unknown;
  modelChoices: ProviderSettingsMigrationModelChoiceV1[];
}> {
  const kinds = new Set<ProviderSettingsMigrationConflictKindV1>();
  const currentBindings = readOwnRecordValue(input.settings.secretBindingsByConnectionId, input.winnerId)?.account;
  const relevantBindings: Array<readonly [string, string | null]> = [];
  for (const [slot, secretId] of accountBindings(input.candidate)) {
    const existing = readOwnRecordValue(currentBindings, slot);
    relevantBindings.push([slot, existing ?? null]);
    if (existing !== undefined && existing !== secretId) kinds.add('credential_binding');
  }
  const existingModels = readOwnRecordValue(input.settings.manualModelsByConnectionId, input.winnerId) ?? [];
  const existingModelsById = new Map(existingModels.map((model) => [model.id, model.name ?? null] as const));
  const relevantModels: Array<Readonly<{ id: string; name: string | null }>> = [];
  for (const model of modelFacts(input.candidate)) {
    if (existingModelsById.has(model.id)) {
      relevantModels.push({ id: model.id, name: existingModelsById.get(model.id) ?? null });
    }
    if (existingModelsById.has(model.id) && existingModelsById.get(model.id) !== model.name) kinds.add('manual_model');
  }
  let relevantDefault: unknown = null;
  let existingModelChoice: ProviderSettingsMigrationModelChoiceV1 | null = null;
  if (input.candidate.selectedModel) {
    const existingDefault = readOwnRecordValue(
      input.settings.defaultsByAgentTargetKey,
      input.candidate.selectedModel.agentTargetKey,
    );
    relevantDefault = existingDefault?.ref ?? null;
    if (existingDefault?.ref.providerConnectionId === input.winnerId) {
      const label = existingModels.find((model) => model.id === existingDefault.ref.modelId)?.name;
      existingModelChoice = {
        kind: 'existing',
        selection: {
          agentTargetKey: existingDefault.ref.agentTargetKey,
          modelId: existingDefault.ref.modelId,
        },
        ...(label ? { label } : {}),
      };
    }
    if (existingDefault?.ref.providerConnectionId === input.winnerId
      && existingDefault.ref.modelId !== input.candidate.selectedModel.modelId) {
      kinds.add('manual_model');
    }
  }
  return {
    kinds: [...kinds].sort(),
    facts: {
      kind: 'persisted_winner',
      bindings: relevantBindings,
      models: relevantModels,
      defaultSelection: relevantDefault,
    },
    modelChoices: (() => {
      if (!kinds.has('manual_model')) return [];
      const choices = [existingModelChoice, legacyModelChoice(input.candidate)]
        .filter((choice): choice is ProviderSettingsMigrationModelChoiceV1 => choice !== null);
      const seen = new Set<string>();
      return choices.filter((choice) => {
        const key = `${choice.selection.agentTargetKey}\0${choice.selection.modelId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })(),
  };
}

export function createLegacyProfileMigrationPendingConflictV1(input: Readonly<{
  candidate: ConnectionCandidate;
  kinds: readonly ProviderSettingsMigrationConflictKindV1[];
  existingConnectionId: string | null;
  detectedAt: number;
  comparisonFacts?: unknown;
  modelChoices?: readonly ProviderSettingsMigrationModelChoiceV1[];
}>): ProviderSettingsMigrationPendingConflictV1 {
  const key = contributionKey(input.candidate);
  if (!key || input.kinds.length === 0) throw new TypeError('Migration conflict requires a default contribution candidate and reason');
  const kinds = [...new Set(input.kinds)].sort();
  return {
    v: 1,
    sourceProfileId: input.candidate.sourceProfileId,
    contributionKey: key,
    existingConnectionId: input.existingConnectionId === null
      ? null
      : ProviderConnectionIdSchema.parse(input.existingConnectionId),
    kinds,
    modelChoices: [...(input.modelChoices ?? [])],
    candidateFingerprint: createProviderFingerprintV1('legacy-profile-migration-conflict', {
      sourceProfileId: input.candidate.sourceProfileId,
      contributionKey: key,
      existingConnectionId: input.existingConnectionId,
      kinds,
      accountBindings: accountBindings(input.candidate),
      models: modelFacts(input.candidate),
      selectedModel: input.candidate.selectedModel ?? null,
      comparisonFacts: input.comparisonFacts ?? null,
      modelChoices: input.modelChoices ?? [],
    }),
    detectedAt: input.detectedAt,
  };
}

/** Removes unsafe automatic candidates and emits bounded, non-secret review records. */
export function classifyLegacyProfileMigrationConflictsV1(
  rawSettings: Readonly<Record<string, unknown>>,
  context: ProviderAccountSettingsMigrationContextV1,
): ProviderAccountSettingsMigrationContextV1 {
  const settings = readProviderSettingsFromAccountSettingsV1(rawSettings).settings;
  const connectionCandidates = context.candidates.filter(
    (candidate): candidate is ConnectionCandidate => candidate.kind === 'connection' && contributionKey(candidate) !== null,
  );
  const kindsBySource = new Map<string, Set<ProviderSettingsMigrationConflictKindV1>>();
  const existingConnectionIdBySource = new Map<string, string | null>();
  const comparisonFactsBySource = new Map<string, unknown[]>();
  const modelChoicesBySource = new Map<string, ProviderSettingsMigrationModelChoiceV1[]>();
  const add = (
    candidate: ConnectionCandidate,
    kinds: readonly ProviderSettingsMigrationConflictKindV1[],
    existingId: string | null,
    comparisonFact: unknown,
    modelChoices: readonly ProviderSettingsMigrationModelChoiceV1[] = [],
  ) => {
    if (kinds.length === 0) return;
    const set = kindsBySource.get(candidate.sourceProfileId) ?? new Set();
    kinds.forEach((kind) => set.add(kind));
    kindsBySource.set(candidate.sourceProfileId, set);
    existingConnectionIdBySource.set(candidate.sourceProfileId, existingId);
    const facts = comparisonFactsBySource.get(candidate.sourceProfileId) ?? [];
    facts.push(comparisonFact);
    comparisonFactsBySource.set(candidate.sourceProfileId, facts);
    if (modelChoices.length > 0) modelChoicesBySource.set(candidate.sourceProfileId, [...modelChoices]);
  };

  const candidateComparisonFact = (candidate: ConnectionCandidate) => ({
    kind: 'same_batch_candidate',
    sourceProfileId: candidate.sourceProfileId,
    accountBindings: accountBindings(candidate),
    models: modelFacts(candidate),
    selectedModel: candidate.selectedModel ?? null,
  });

  for (let leftIndex = 0; leftIndex < connectionCandidates.length; leftIndex += 1) {
    const left = connectionCandidates[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < connectionCandidates.length; rightIndex += 1) {
      const right = connectionCandidates[rightIndex]!;
      if (contributionKey(left) !== contributionKey(right)) continue;
      const kinds = pairConflictKinds(left, right);
      add(left, kinds, null, candidateComparisonFact(right));
      add(right, kinds, null, candidateComparisonFact(left));
    }
  }

  for (const candidate of connectionCandidates) {
    const key = contributionKey(candidate)!;
    const winner = settings.connections.find((connection) =>
      connection.role === 'default'
      && connection.source.kind === 'contribution'
      && connection.source.contributionKey === key);
    if (!winner) continue;
    const persisted = persistedWinnerConflict({ candidate, winnerId: winner.id, settings });
    add(candidate, persisted.kinds, winner.id, persisted.facts, persisted.modelChoices);
  }

  if (kindsBySource.size === 0) return { ...context, pendingConflicts: [] };
  const persistedBySource = new Map(
    (settings.migration?.pendingConflicts ?? []).map((conflict) => [conflict.sourceProfileId, conflict] as const),
  );
  const pendingBySource = new Map<string, ProviderSettingsMigrationPendingConflictV1>();
  for (const candidate of connectionCandidates) {
    const kinds = kindsBySource.get(candidate.sourceProfileId);
    if (!kinds) continue;
    const next = createLegacyProfileMigrationPendingConflictV1({
      candidate,
      kinds: [...kinds],
      existingConnectionId: existingConnectionIdBySource.get(candidate.sourceProfileId) ?? null,
      detectedAt: context.migratedAt,
      comparisonFacts: (comparisonFactsBySource.get(candidate.sourceProfileId) ?? [])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      modelChoices: modelChoicesBySource.get(candidate.sourceProfileId) ?? [],
    });
    const persisted = persistedBySource.get(candidate.sourceProfileId);
    pendingBySource.set(
      candidate.sourceProfileId,
      persisted?.candidateFingerprint === next.candidateFingerprint ? persisted : next,
    );
  }
  return {
    ...context,
    candidates: context.candidates.filter((candidate) => !kindsBySource.has(candidate.sourceProfileId)),
    pendingConflicts: [...pendingBySource.values()].sort((left, right) => left.sourceProfileId.localeCompare(right.sourceProfileId)),
  };
}

export type ResolveLegacyProfileMigrationConflictResultV1 =
  | Readonly<{ ok: true; context: ProviderAccountSettingsMigrationContextV1 }>
  | Readonly<{ ok: false; reason: 'migration_conflict_changed' | 'migration_conflict_resolution_invalid' }>;

/** Applies reviewed intent only when the latest raw settings reproduce the exact conflict fingerprint. */
export function resolveLegacyProfileMigrationConflictV1(
  rawSettings: Readonly<Record<string, unknown>>,
  baseContext: ProviderAccountSettingsMigrationContextV1,
  rawResolution: LegacyProfileMigrationConflictResolutionV1,
): ResolveLegacyProfileMigrationConflictResultV1 {
  return applyReviewedLegacyProfileMigrationConflictV1(
    rawSettings,
    baseContext,
    classifyLegacyProfileMigrationConflictsV1(rawSettings, baseContext),
    rawResolution,
  );
}

/**
 * Applies a conflict record already re-derived by an authoritative adapter.
 * The separate authoritative context is required for async DNS/security
 * conflicts that protocol-pure persisted-state comparison cannot reproduce.
 */
export function applyReviewedLegacyProfileMigrationConflictV1(
  rawSettings: Readonly<Record<string, unknown>>,
  baseContext: ProviderAccountSettingsMigrationContextV1,
  authoritativeContext: ProviderAccountSettingsMigrationContextV1,
  rawResolution: LegacyProfileMigrationConflictResolutionV1,
): ResolveLegacyProfileMigrationConflictResultV1 {
  const parsedResolution = LegacyProfileMigrationConflictResolutionV1Schema.safeParse(rawResolution);
  if (!parsedResolution.success) return { ok: false, reason: 'migration_conflict_resolution_invalid' };
  const resolution = parsedResolution.data;
  const original = baseContext.candidates.find(
    (candidate): candidate is ConnectionCandidate =>
      candidate.kind === 'connection' && candidate.sourceProfileId === resolution.sourceProfileId,
  );
  if (!original) return { ok: false, reason: 'migration_conflict_changed' };
  const conflict = authoritativeContext.pendingConflicts?.find(
    (entry) => entry.sourceProfileId === resolution.sourceProfileId,
  );
  if (!conflict || conflict.candidateFingerprint !== resolution.expectedCandidateFingerprint) {
    return { ok: false, reason: 'migration_conflict_changed' };
  }

  let resolvedCandidate: ConnectionCandidate;
  if (resolution.decision.kind === 'keep_existing') {
    const existingConnectionId = resolution.decision.existingConnectionId;
    if (conflict.existingConnectionId !== existingConnectionId) {
      return { ok: false, reason: 'migration_conflict_changed' };
    }
    const settings = readProviderSettingsFromAccountSettingsV1(rawSettings).settings;
    const existing = settings.connections.find((connection) =>
      connection.id === existingConnectionId
      && connection.role === 'default'
      && connection.source.kind === 'contribution'
      && connection.source.contributionKey === conflict.contributionKey);
    if (!existing) return { ok: false, reason: 'migration_conflict_changed' };
    const hasModelConflict = conflict.kinds.includes('manual_model');
    if (hasModelConflict && resolution.decision.modelSelection === undefined) {
      return { ok: false, reason: 'migration_conflict_resolution_invalid' };
    }
    if (hasModelConflict && resolution.decision.modelSelection) {
      const selected = resolution.decision.modelSelection;
      const allowed = conflict.modelChoices.some((choice) =>
        choice.selection.agentTargetKey === selected.agentTargetKey
        && choice.selection.modelId === selected.modelId);
      if (!allowed) {
        return { ok: false, reason: 'migration_conflict_resolution_invalid' };
      }
    } else if (!hasModelConflict && resolution.decision.modelSelection !== undefined) {
      return { ok: false, reason: 'migration_conflict_resolution_invalid' };
    }
    const {
      secretBindings: _discardedSecretBindings,
      accountGrant: _discardedGrant,
      ...profileDisposition
    } = original;
    if (hasModelConflict) {
      const {
        manualModels: _discardedManualModels,
        selectedModel: _discardedSelectedModel,
        ...withoutModelConflict
      } = profileDisposition;
      resolvedCandidate = {
        ...withoutModelConflict,
        connection: existing,
        ...(resolution.decision.modelSelection
          ? { selectedModel: resolution.decision.modelSelection }
          : {}),
      };
    } else {
      resolvedCandidate = { ...profileDisposition, connection: existing };
    }
  } else {
    const { accountGrant: _discardedGrant, ...candidateWithoutGrant } = original;
    resolvedCandidate = {
      ...candidateWithoutGrant,
      connection: {
        ...original.connection,
        id: resolution.decision.connectionId,
        role: 'named',
        displayName: resolution.decision.displayName,
        displayNameMode: 'custom',
        revision: 0,
        updatedAt: baseContext.migratedAt,
      },
    };
  }
  return {
    ok: true,
    context: {
      ...authoritativeContext,
      candidates: [...authoritativeContext.candidates, resolvedCandidate]
        .sort((left, right) => left.sourceProfileId.localeCompare(right.sourceProfileId)),
      pendingConflicts: (authoritativeContext.pendingConflicts ?? [])
        .filter((entry) => entry.sourceProfileId !== resolution.sourceProfileId),
    },
  };
}
