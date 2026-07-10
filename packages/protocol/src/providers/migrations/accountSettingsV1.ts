import type { ProviderConnectionV1 } from '../connections/v1.js';
import { ProviderConnectionV1Schema } from '../connections/v1.js';
import type { ProviderAccountGrantV1 } from '../grants/v1.js';
import type { ProviderManualModelV1, ProviderSettingsV1 } from '../settings/v1.js';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  assertProviderSettingsV1WithinLimits,
  type ProviderSettingsMigrationSourceOutcomeV1,
} from '../settings/v1.js';
import { classifyProviderSettingsSubtreeV1 } from '../settings/classifySubtreeV1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
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
      kind: 'connection';
      sourceProfileId: string;
      connection: ProviderConnectionV1;
      secretBindings?: ProviderMigrationSecretBindingsV1;
      manualModels?: readonly ProviderManualModelV1[];
      accountGrant?: ProviderAccountGrantV1;
    }>;

export type ProviderAccountSettingsMigrationContextV1 = Readonly<{
  migratedAt: number;
  candidates: readonly ProviderAccountSettingsMigrationCandidateV1[];
  pendingCustomProfileIds: readonly string[];
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
      reason: 'account_settings_invalid' | 'provider_settings_future' | 'provider_settings_malformed' | 'provider_settings_invalid' | 'provider_settings_limit_exceeded' | 'migration_context_invalid';
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
    if (candidate.kind === 'default_environment') {
      candidates.push(candidate);
      continue;
    }
    const connection = ProviderConnectionV1Schema.safeParse(candidate.connection);
    if (!connection.success
      || (candidate.accountGrant !== undefined && candidate.accountGrant.connectionId !== connection.data.id)) {
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
    if (candidate.kind === 'default_environment') {
      const outcome = { sourceProfileId: candidate.sourceProfileId, kind: 'default_environment' as const };
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
    const outcome = { sourceProfileId: candidate.sourceProfileId, kind: 'connection' as const, connectionId: selected.id };
    completedSources.push(outcome);
    outcomesBySourceProfileId.set(candidate.sourceProfileId, outcome);

    const mergedBindings = mergeSecretBindings(readOwnRecordValue(secretBindingsByConnectionId, selected.id), candidate.secretBindings);
    if (mergedBindings) secretBindingsByConnectionId[selected.id] = mergedBindings;

    const existingModels = readOwnRecordValue(manualModelsByConnectionId, selected.id) ?? [];
    const modelsById = new Map(existingModels.map((model) => [model.id, model]));
    for (const model of candidate.manualModels ?? []) if (!modelsById.has(model.id)) modelsById.set(model.id, model);
    if (modelsById.size > 0) manualModelsByConnectionId[selected.id] = [...modelsById.values()];

    if (candidate.accountGrant && !accountGrants.some((grant) => grant.connectionId === selected.id)) {
      accountGrants.push({ ...candidate.accountGrant, connectionId: selected.id });
    }
    changed = true;
  }

  const pendingCustomProfileIds = [...new Set([
    ...(current.migration?.pendingCustomProfileIds ?? []),
    ...context.pendingCustomProfileIds,
  ])].filter((id) => !outcomesBySourceProfileId.has(id)).sort();
  completedSources.sort((a, b) => a.sourceProfileId.localeCompare(b.sourceProfileId));
  const migration = {
    v: 1 as const,
    completedSources,
    pendingCustomProfileIds,
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
