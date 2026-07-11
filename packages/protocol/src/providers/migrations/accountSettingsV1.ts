import type { ProviderConnectionV1 } from '../connections/v1.js';
import { ProviderConnectionV1Schema } from '../connections/v1.js';
import type { ProviderAccountGrantV1 } from '../grants/v1.js';
import type { ProviderManualModelV1, ProviderSettingsV1 } from '../settings/v1.js';
import type { ProviderSettingsMigrationPendingConflictV1 } from '../settings/v1.js';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsMigrationPendingConflictV1Schema,
  ProviderSettingsV1Schema,
  assertProviderSettingsV1WithinLimits,
  type ProviderSettingsMigrationSourceOutcomeV1,
} from '../settings/v1.js';
import { classifyProviderSettingsSubtreeV1 } from '../settings/classifySubtreeV1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import { LaunchProfileV2Schema, type LaunchProfileV2 } from '../../profiles/v2/schema.js';
import { ProviderAgentTargetKeySchema, ProviderModelIdSchema } from '../ids.js';
export { classifyProviderSettingsSubtreeV1 } from '../settings/classifySubtreeV1.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ProviderMigrationSecretBindingsV1 = Readonly<{
  account?: Readonly<Record<string, string>>;
  byMachineId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export type ProviderAccountSettingsMigrationCandidateV1 =
  | Readonly<{
      kind: 'default_environment';
      sourceProfileId: string;
    }>
  | Readonly<{
      kind: 'skipped_disabled';
      sourceProfileId: string;
    }>
  | Readonly<{
      kind: 'connection';
      sourceProfileId: string;
      connection: ProviderConnectionV1;
      secretBindings?: ProviderMigrationSecretBindingsV1;
      manualModels?: readonly ProviderManualModelV1[];
      accountGrant?: ProviderAccountGrantV1;
      selectedModel?: Readonly<{ agentTargetKey: string; modelId: string }>;
      removedEnvironmentVariableNames?: readonly string[];
      movedSecretBindingEnvironmentVariableNames?: readonly string[];
      retainedLaunchProfile?: LaunchProfileV2;
    }>;

export type ProviderAccountSettingsMigrationContextV1 = Readonly<{
  migratedAt: number;
  candidates: readonly ProviderAccountSettingsMigrationCandidateV1[];
  pendingCustomProfileIds: readonly string[];
  pendingConflicts?: readonly ProviderSettingsMigrationPendingConflictV1[];
}>;

export type ProviderAccountSettingsMigrationResultV1 =
  | Readonly<{
      ok: true;
      changed: boolean;
      settings: Record<string, unknown>;
      outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[];
    }>
  | Readonly<{
      ok: false;
      changed: false;
      settings: unknown;
      reason: 'account_settings_invalid' | 'provider_settings_future' | 'provider_settings_malformed' | 'provider_settings_invalid' | 'provider_settings_limit_exceeded' | 'migration_context_invalid' | 'migration_conflict';
    }>;

function isCanonicalSourceProfileId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mergeSecretBindings(
  current: ProviderMigrationSecretBindingsV1 | undefined,
  incoming: ProviderMigrationSecretBindingsV1 | undefined,
): ProviderMigrationSecretBindingsV1 | undefined {
  if (!current && !incoming) return undefined;
  const account = { ...(incoming?.account ?? {}), ...(current?.account ?? {}) };
  const machineIds = new Set([
    ...Object.keys(incoming?.byMachineId ?? {}),
    ...Object.keys(current?.byMachineId ?? {}),
  ]);
  const byMachineId: Record<string, Readonly<Record<string, string>>> = {};
  for (const machineId of [...machineIds].sort()) {
    byMachineId[machineId] = {
      ...(readOwnRecordValue(incoming?.byMachineId, machineId) ?? {}),
      ...(readOwnRecordValue(current?.byMachineId, machineId) ?? {}),
    };
  }
  return {
    ...(Object.keys(account).length > 0 ? { account } : {}),
    ...(Object.keys(byMachineId).length > 0 ? { byMachineId } : {}),
  };
}

function hasSecretBindingConflict(
  current: ProviderMigrationSecretBindingsV1 | undefined,
  incoming: ProviderMigrationSecretBindingsV1 | undefined,
): boolean {
  const compareScope = (
    left: Readonly<Record<string, string>> | undefined,
    right: Readonly<Record<string, string>> | undefined,
  ): boolean => Object.entries(right ?? {}).some(([slot, secretId]) => {
    const existing = readOwnRecordValue(left, slot);
    return existing !== undefined && existing !== secretId;
  });
  if (compareScope(current?.account, incoming?.account)) return true;
  for (const [machineId, bindings] of Object.entries(incoming?.byMachineId ?? {})) {
    if (compareScope(readOwnRecordValue(current?.byMachineId, machineId), bindings)) return true;
  }
  return false;
}

function hasEquivalentManualModelFacts(left: ProviderManualModelV1, right: ProviderManualModelV1): boolean {
  return left.id === right.id && left.name === right.name;
}

function validEnvironmentNameList(value: readonly string[] | undefined): boolean {
  if (!value) return true;
  return value.length <= 256
    && new Set(value).size === value.length
    && value.every((name) => /^[A-Z_][A-Z0-9_]*$/u.test(name) && name.length <= 128);
}

export function migrateProviderAccountSettingsV1(
  raw: unknown,
  context: ProviderAccountSettingsMigrationContextV1,
): ProviderAccountSettingsMigrationResultV1 {
  const classification = classifyProviderSettingsSubtreeV1(raw);
  if (classification.kind === 'future') {
    return { ok: false, changed: false, settings: raw, reason: 'provider_settings_future' };
  }
  if (classification.kind === 'malformed') {
    return {
      ok: false,
      changed: false,
      settings: raw,
      reason: isRecord(raw) ? 'provider_settings_malformed' : 'account_settings_invalid',
    };
  }
  if (!isRecord(raw) || !Number.isFinite(context.migratedAt) || context.migratedAt < 0) {
    return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
  }

  const parsedProviderSettings = classification.kind === 'current'
    ? classification.settings
    : DEFAULT_PROVIDER_SETTINGS_V1;

  const sourceProfileIds = new Set<string>();
  const candidates: ProviderAccountSettingsMigrationCandidateV1[] = [];
  for (const candidate of context.candidates) {
    if (!isCanonicalSourceProfileId(candidate.sourceProfileId) || sourceProfileIds.has(candidate.sourceProfileId)) {
      return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
    }
    sourceProfileIds.add(candidate.sourceProfileId);
    if (candidate.kind === 'default_environment' || candidate.kind === 'skipped_disabled') {
      candidates.push(candidate);
      continue;
    }
    const connection = ProviderConnectionV1Schema.safeParse(candidate.connection);
    if (!connection.success
      || (candidate.accountGrant !== undefined && candidate.accountGrant.connectionId !== connection.data.id)
      || !validEnvironmentNameList(candidate.removedEnvironmentVariableNames)
      || !validEnvironmentNameList(candidate.movedSecretBindingEnvironmentVariableNames)
      || candidate.movedSecretBindingEnvironmentVariableNames?.some(
        (name) => !candidate.removedEnvironmentVariableNames?.includes(name)) === true
      || (candidate.retainedLaunchProfile !== undefined
        && !LaunchProfileV2Schema.safeParse(candidate.retainedLaunchProfile).success)
      || (candidate.selectedModel !== undefined && (!ProviderAgentTargetKeySchema.safeParse(candidate.selectedModel.agentTargetKey).success
        || !ProviderModelIdSchema.safeParse(candidate.selectedModel.modelId).success))) {
      return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
    }
    const normalizedCandidate = ProviderSettingsV1Schema.safeParse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [connection.data],
      accountGrants: candidate.accountGrant ? [candidate.accountGrant] : [],
      secretBindingsByConnectionId: candidate.secretBindings
        ? { [connection.data.id]: candidate.secretBindings }
        : {},
      manualModelsByConnectionId: candidate.manualModels?.length
        ? { [connection.data.id]: candidate.manualModels }
        : {},
    });
    if (!normalizedCandidate.success) {
      return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
    }
    candidates.push({
      ...candidate,
      connection: normalizedCandidate.data.connections[0]!,
      ...(candidate.accountGrant ? { accountGrant: normalizedCandidate.data.accountGrants[0]! } : {}),
      ...(candidate.secretBindings
        ? { secretBindings: normalizedCandidate.data.secretBindingsByConnectionId[connection.data.id] }
        : {}),
      ...(candidate.manualModels?.length
        ? { manualModels: normalizedCandidate.data.manualModelsByConnectionId[connection.data.id] }
        : {}),
    });
  }
  if (context.pendingCustomProfileIds.some((id) => !isCanonicalSourceProfileId(id))
    || new Set(context.pendingCustomProfileIds).size !== context.pendingCustomProfileIds.length) {
    return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
  }
  const pendingConflicts = context.pendingConflicts ?? [];
  if (pendingConflicts.some((entry) => !ProviderSettingsMigrationPendingConflictV1Schema.safeParse(entry).success)
    || new Set(pendingConflicts.map((entry) => entry.sourceProfileId)).size !== pendingConflicts.length
    || pendingConflicts.some((entry) => sourceProfileIds.has(entry.sourceProfileId))) {
    return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
  }

  const current = parsedProviderSettings;
  const connections = [...current.connections];
  const accountGrants = [...current.accountGrants];
  const secretBindingsByConnectionId: Record<string, ProviderMigrationSecretBindingsV1> = { ...current.secretBindingsByConnectionId };
  const manualModelsByConnectionId: Record<string, readonly ProviderManualModelV1[]> = { ...current.manualModelsByConnectionId };
  const completedSources = [...(current.migration?.completedSources ?? [])];
  const outcomesBySourceProfileId = new Map(
    completedSources.map((outcome) => [outcome.sourceProfileId, outcome] as const),
  );
  let changed = classification.kind === 'absent';

  for (const candidate of candidates) {
    const completed = outcomesBySourceProfileId.get(candidate.sourceProfileId);
    if (completed) {
      continue;
    }
    if (candidate.kind === 'default_environment' || candidate.kind === 'skipped_disabled') {
      const outcome = { sourceProfileId: candidate.sourceProfileId, kind: candidate.kind } as const;
      completedSources.push(outcome);
      outcomesBySourceProfileId.set(candidate.sourceProfileId, outcome);
      changed = true;
      continue;
    }

    const contributionKey = candidate.connection.role === 'default' && candidate.connection.source.kind === 'contribution'
      ? candidate.connection.source.contributionKey
      : null;
    const winner = contributionKey === null ? undefined : connections.find((connection) =>
      connection.role === 'default'
      && connection.source.kind === 'contribution'
      && connection.source.contributionKey === contributionKey);
    const selected = winner ?? candidate.connection;
    if (!winner) {
      if (connections.some((connection) => connection.id === selected.id)
        || current.connectionTombstones.some((tombstone) => tombstone.id === selected.id)) {
        return { ok: false, changed: false, settings: raw, reason: 'migration_context_invalid' };
      }
      connections.push(selected);
    }
    const outcome = {
      sourceProfileId: candidate.sourceProfileId,
      kind: 'connection' as const,
      connectionId: selected.id,
      ...(candidate.selectedModel ? {
        modelSelection: {
          agentTargetKey: candidate.selectedModel.agentTargetKey,
          providerConnectionId: selected.id,
          modelId: candidate.selectedModel.modelId,
        },
      } : {}),
    };
    completedSources.push(outcome);
    outcomesBySourceProfileId.set(candidate.sourceProfileId, outcome);

    const currentBindings = readOwnRecordValue(secretBindingsByConnectionId, selected.id);
    if (hasSecretBindingConflict(currentBindings, candidate.secretBindings)) {
      return { ok: false, changed: false, settings: raw, reason: 'migration_conflict' };
    }
    const mergedBindings = mergeSecretBindings(currentBindings, candidate.secretBindings);
    if (mergedBindings) secretBindingsByConnectionId[selected.id] = mergedBindings;

    const existingModels = readOwnRecordValue(manualModelsByConnectionId, selected.id) ?? [];
    const modelsById = new Map(existingModels.map((model) => [model.id, model]));
    for (const model of candidate.manualModels ?? []) {
      const existing = modelsById.get(model.id);
      if (existing && !hasEquivalentManualModelFacts(existing, model)) {
        return { ok: false, changed: false, settings: raw, reason: 'migration_conflict' };
      }
      if (!existing) modelsById.set(model.id, model);
    }
    if (modelsById.size > 0) manualModelsByConnectionId[selected.id] = [...modelsById.values()];

    if (candidate.accountGrant
      && selected.id === candidate.connection.id
      && !accountGrants.some((grant) => grant.connectionId === selected.id)) {
      accountGrants.push(candidate.accountGrant);
    }
    changed = true;
  }

  const pendingCustomProfileIds = [...new Set([
    ...(current.migration?.pendingCustomProfileIds ?? []),
    ...context.pendingCustomProfileIds,
  ])].filter((id) => !outcomesBySourceProfileId.has(id)).sort();
  const pendingConflictBySource = new Map(
    (context.pendingConflicts === undefined ? current.migration?.pendingConflicts ?? [] : [])
      .map((entry) => [entry.sourceProfileId, entry] as const),
  );
  for (const conflict of pendingConflicts) pendingConflictBySource.set(conflict.sourceProfileId, conflict);
  for (const sourceProfileId of outcomesBySourceProfileId.keys()) pendingConflictBySource.delete(sourceProfileId);
  completedSources.sort((a, b) => a.sourceProfileId.localeCompare(b.sourceProfileId));
  const migration = {
    v: 1 as const,
    completedSources,
    pendingCustomProfileIds,
    pendingConflicts: [...pendingConflictBySource.values()].sort((left, right) =>
      left.sourceProfileId.localeCompare(right.sourceProfileId)),
    migratedAt: current.migration?.migratedAt ?? context.migratedAt,
  };
  if (JSON.stringify(migration) !== JSON.stringify(current.migration)) changed = true;

  let nextProviderSettings: ProviderSettingsV1;
  try {
    nextProviderSettings = assertProviderSettingsV1WithinLimits({
      ...current,
      connections,
      accountGrants,
      secretBindingsByConnectionId,
      manualModelsByConnectionId,
      migration,
    });
  } catch (error) {
    return {
      ok: false,
      changed: false,
      settings: raw,
      reason: error instanceof ProviderSettingsLimitError
        ? 'provider_settings_limit_exceeded'
        : 'provider_settings_invalid',
    };
  }
  const outcomes = [...outcomesBySourceProfileId.values()]
    .sort((a, b) => a.sourceProfileId.localeCompare(b.sourceProfileId));
  if (!changed) {
    return { ok: true, changed: false, settings: raw, outcomes };
  }
  return {
    ok: true,
    changed: true,
    settings: {
      ...raw,
      providerSettingsV1: nextProviderSettings,
    },
    outcomes,
  };
}
