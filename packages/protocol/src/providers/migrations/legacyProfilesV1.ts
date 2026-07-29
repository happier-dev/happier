import { z } from 'zod';

import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { AIBackendProfileSchema, type AIBackendProfile } from '../../profiles/backendProfileSchema.js';
import { LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1, LaunchProfileV2Schema, type LaunchProfileV2 } from '../../profiles/v2/schema.js';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '../selection/v1.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import { ProviderConnectionV1Schema } from '../connections/v1.js';
import { ProviderAgentTargetKeySchema, ProviderLocalIdSchema, ProviderModelIdSchema } from '../ids.js';
import { isCanonicalProviderSavedSecretIdV1 } from '../settings/v1.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import {
  classifyProviderSettingsSubtreeV1,
  migrateProviderAccountSettingsV1,
  type ProviderAccountSettingsMigrationCandidateV1,
  type ProviderAccountSettingsMigrationContextV1,
  type ProviderAccountSettingsMigrationResultV1,
} from './accountSettingsV1.js';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isLegacyAiLaunchEndpointLikeEnvironmentNameV1(name: string): boolean {
  return /(?:^|_)(?:BASE_URL|ENDPOINT|API_URL)$/u.test(name);
}

function candidateContributionKey(candidate: ProviderAccountSettingsMigrationCandidateV1): string | null {
  return candidate.kind === 'connection'
    && candidate.connection.source.kind === 'contribution'
    && candidate.connection.role === 'default'
    ? canonicalizeProviderContributionKeyV1(candidate.connection.source.contributionKey)
    : null;
}

function hasConflictingConnectionCandidates(candidates: readonly ProviderAccountSettingsMigrationCandidateV1[]): boolean {
  const byContribution = new Map<string, Extract<ProviderAccountSettingsMigrationCandidateV1, { kind: 'connection' }>[]>();
  for (const candidate of candidates) {
    const contributionKey = candidateContributionKey(candidate);
    if (contributionKey === null || candidate.kind !== 'connection') continue;
    const group = byContribution.get(contributionKey) ?? [];
    group.push(candidate);
    byContribution.set(contributionKey, group);
  }
  for (const group of byContribution.values()) {
    const slotValues = new Map<string, string>();
    const modelValues = new Map<string, string>();
    for (const candidate of group) {
      for (const [slot, secretId] of Object.entries(candidate.secretBindings?.account ?? {})) {
        const prior = slotValues.get(slot);
        if (prior !== undefined && prior !== secretId) return true;
        slotValues.set(slot, secretId);
      }
      for (const model of candidate.manualModels ?? []) {
        const value = JSON.stringify({ id: model.id, name: model.name ?? null });
        const prior = modelValues.get(model.id);
        if (prior !== undefined && prior !== value) return true;
        modelValues.set(model.id, value);
      }
    }
  }
  return false;
}

function toSelection(
  candidate: Extract<ProviderAccountSettingsMigrationCandidateV1, { kind: 'connection' }>,
  connectionId: string,
  updatedAt: number,
): SessionModelSelectionV1 | null {
  if (!candidate.selectedModel) return null;
  return SessionModelSelectionV1Schema.parse({
    v: 1,
    ref: {
      agentTargetKey: candidate.selectedModel.agentTargetKey,
      providerConnectionId: connectionId,
      modelId: candidate.selectedModel.modelId,
    },
    updatedAt,
  });
}

function hasSameAgentTargetIdentity(left: string, right: string): boolean {
  try {
    return buildBackendTargetKeyV2(readBackendTargetRefV2(left))
      === buildBackendTargetKeyV2(readBackendTargetRefV2(right));
  } catch {
    return false;
  }
}

function repairSelectionForKnownMigration(
  value: unknown,
  canonical: SessionModelSelectionV1,
): SessionModelSelectionV1 | null {
  const parsed = SessionModelSelectionV1Schema.safeParse(value);
  if (!parsed.success
    || parsed.data.ref.providerConnectionId !== canonical.ref.providerConnectionId
    || parsed.data.ref.modelId !== canonical.ref.modelId
    || !hasSameAgentTargetIdentity(parsed.data.ref.agentTargetKey, canonical.ref.agentTargetKey)) {
    return null;
  }
  return SessionModelSelectionV1Schema.parse({
    ...parsed.data,
    ref: { ...parsed.data.ref, agentTargetKey: canonical.ref.agentTargetKey },
  });
}

type LegacySourceDispositionV1 = 'migrate_legacy_state' | 'repair_provider_outputs_only';

function readCompletedConnectionOutcome(
  raw: RecordValue,
  sourceProfileId: string,
) {
  const classified = classifyProviderSettingsSubtreeV1(raw);
  if (classified.kind !== 'current') return null;
  for (const outcome of classified.settings.migration?.completedSources ?? []) {
    if (outcome.sourceProfileId === sourceProfileId && outcome.kind === 'connection') return outcome;
  }
  return null;
}

function legacySourceDisposition(
  raw: RecordValue,
  candidate: ProviderAccountSettingsMigrationCandidateV1,
): LegacySourceDispositionV1 {
  if (candidate.kind !== 'connection' || !candidate.selectedModel) return 'migrate_legacy_state';
  const completed = readCompletedConnectionOutcome(raw, candidate.sourceProfileId);
  if (completed?.connectionId !== candidate.connection.id
    || !completed.modelSelection
    || completed.modelSelection.modelId !== candidate.selectedModel.modelId
    || !hasSameAgentTargetIdentity(
      completed.modelSelection.agentTargetKey,
      candidate.selectedModel.agentTargetKey,
    )) {
    return 'migrate_legacy_state';
  }
  return 'repair_provider_outputs_only';
}

function slimLegacyProfile(
  profile: AIBackendProfile,
  preferredModelSelection: SessionModelSelectionV1 | null,
  additionallyRemovedEnvironmentVariableNames: readonly string[] = [],
): LaunchProfileV2 | null {
  const removed = new Set([...LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1, ...additionallyRemovedEnvironmentVariableNames]);
  const extraEnvironmentVariables = profile.environmentVariables.filter(
    (entry) => !removed.has(entry.name),
  );
  const envVarRequirements = profile.envVarRequirements.filter(
    (entry) => !removed.has(entry.name),
  );
  const hasPreferences = extraEnvironmentVariables.length > 0
    || envVarRequirements.length > 0
    || Object.keys(profile.defaultPermissionModeByTargetKey).length > 0
    || Object.keys(profile.defaultPersistenceModeByTargetKey).length > 0
    || Object.keys(profile.compatibilityByTargetKey).length > 0
    || Boolean(profile.description);
  if (!hasPreferences) return null;
  return LaunchProfileV2Schema.parse({
    v: 2,
    id: profile.id,
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    extraEnvironmentVariables,
    envVarRequirements,
    defaultPermissionModeByTargetKey: profile.defaultPermissionModeByTargetKey,
    defaultPersistenceModeByTargetKey: profile.defaultPersistenceModeByTargetKey,
    compatibilityByTargetKey: profile.compatibilityByTargetKey,
    ...(preferredModelSelection ? { preferredModelSelection } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

export type LegacyAiLaunchProfilesMigrationResultV1 = ProviderAccountSettingsMigrationResultV1 | Readonly<{
  ok: false;
  changed: false;
  settings: unknown;
  reason: 'migration_conflict';
}>;

export function migrateLegacyAiLaunchProfilesV1(
  raw: unknown,
  context: ProviderAccountSettingsMigrationContextV1,
): LegacyAiLaunchProfilesMigrationResultV1 {
  if (!isRecord(raw)) return migrateProviderAccountSettingsV1(raw, context);
  if (context.candidates.length === 0
    && context.pendingCustomProfileIds.length === 0
    && (context.pendingConflicts?.length ?? 0) === 0) {
    return { ok: true, changed: false, settings: raw, outcomes: [] };
  }
  if (hasConflictingConnectionCandidates(context.candidates)) {
    return { ok: false, changed: false, settings: raw, reason: 'migration_conflict' };
  }
  const migrated = migrateProviderAccountSettingsV1(raw, context);
  if (!migrated.ok || !migrated.changed) return migrated;

  const outcomeBySource = new Map(migrated.outcomes.map((outcome) => [outcome.sourceProfileId, outcome]));
  const candidateBySource = new Map(context.candidates.map((candidate) => [candidate.sourceProfileId, candidate]));
  const dispositionBySource = new Map(context.candidates.map((candidate) => [
    candidate.sourceProfileId,
    legacySourceDisposition(raw, candidate),
  ] as const));
  const selectionsBySource = new Map<string, SessionModelSelectionV1>();
  for (const outcome of migrated.outcomes) {
    const candidate = candidateBySource.get(outcome.sourceProfileId);
    if (candidate?.kind !== 'connection' || outcome.kind !== 'connection') continue;
    const selection = toSelection(candidate, outcome.connectionId, context.migratedAt);
    if (selection) selectionsBySource.set(outcome.sourceProfileId, selection);
  }

  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const retainedProfiles: unknown[] = [];
  const retainedProfileIds = new Set<string>();
  for (const entry of rawProfiles) {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
    const outcome = id ? outcomeBySource.get(id) : undefined;
    const disposition = id ? dispositionBySource.get(id) : undefined;
    if (!id || !outcome || !disposition || outcome.kind === 'skipped_disabled') {
      retainedProfiles.push(entry);
      if (id) retainedProfileIds.add(id);
      continue;
    }
    const parsedSlim = LaunchProfileV2Schema.safeParse(entry);
    if (parsedSlim.success) {
      const canonical = selectionsBySource.get(id) ?? null;
      const repairedSelection = canonical
        ? repairSelectionForKnownMigration(parsedSlim.data.preferredModelSelection, canonical)
        : null;
      retainedProfiles.push(repairedSelection
        ? LaunchProfileV2Schema.parse({
            ...parsedSlim.data,
            preferredAgentTargetKey: undefined,
            preferredModelSelection: repairedSelection,
          })
        : parsedSlim.data);
      retainedProfileIds.add(id);
      continue;
    }
    if (disposition === 'repair_provider_outputs_only') {
      retainedProfiles.push(entry);
      retainedProfileIds.add(id);
      continue;
    }
    const parsedLegacy = AIBackendProfileSchema.safeParse(entry);
    if (!parsedLegacy.success) {
      retainedProfiles.push(entry);
      retainedProfileIds.add(id);
      continue;
    }
    if (outcome.kind === 'connection') {
      const candidate = candidateBySource.get(id);
      const slim = slimLegacyProfile(
        parsedLegacy.data,
        selectionsBySource.get(id) ?? null,
        candidate?.kind === 'connection' ? candidate.removedEnvironmentVariableNames ?? [] : [],
      );
      if (slim) {
        retainedProfiles.push(slim);
        retainedProfileIds.add(id);
      }
    }
  }
  for (const outcome of migrated.outcomes) {
    if (outcome.kind !== 'connection' || retainedProfileIds.has(outcome.sourceProfileId)) continue;
    if (dispositionBySource.get(outcome.sourceProfileId) !== 'migrate_legacy_state') continue;
    const candidate = candidateBySource.get(outcome.sourceProfileId);
    if (candidate?.kind !== 'connection' || !candidate.retainedLaunchProfile) continue;
    const selection = selectionsBySource.get(outcome.sourceProfileId);
    const retained = LaunchProfileV2Schema.parse({
      ...candidate.retainedLaunchProfile,
      ...(selection ? { preferredModelSelection: selection } : {}),
    });
    retainedProfiles.push(retained);
    retainedProfileIds.add(outcome.sourceProfileId);
  }

  const lastUsedProfile = typeof raw.lastUsedProfile === 'string' ? raw.lastUsedProfile : null;
  const favoriteProfiles = Array.isArray(raw.favoriteProfiles)
    ? raw.favoriteProfiles.filter((id): id is string => typeof id === 'string')
    : [];
  const favoriteModelSelections = Array.isArray(raw.favoriteModelSelectionsV1)
    ? raw.favoriteModelSelectionsV1.map((entry) => {
        if (!isRecord(entry)) return entry;
        for (const canonical of selectionsBySource.values()) {
          const repaired = repairSelectionForKnownMigration(entry.selection, canonical);
          if (repaired) return { ...entry, selection: repaired };
        }
        return entry;
      })
    : [];
  for (const sourceId of favoriteProfiles) {
    if (dispositionBySource.get(sourceId) !== 'migrate_legacy_state') continue;
    const selection = selectionsBySource.get(sourceId);
    const favorite = selection ? { selection, addedAtMs: context.migratedAt } : null;
    if (favorite && !favoriteModelSelections.some((entry) =>
      isRecord(entry) && JSON.stringify(entry.selection) === JSON.stringify(selection))) {
      favoriteModelSelections.push(favorite);
    }
  }

  const nextBindings: Record<string, unknown> = Object.create(null);
  if (isRecord(raw.secretBindingsByProfileId)) {
    for (const [profileId, bindings] of Object.entries(raw.secretBindingsByProfileId)) {
      const outcome = outcomeBySource.get(profileId);
      if (!outcome
        || dispositionBySource.get(profileId) !== 'migrate_legacy_state'
        || outcome.kind === 'skipped_disabled') {
        nextBindings[profileId] = bindings;
        continue;
      }
      const candidate = candidateBySource.get(profileId);
      if (outcome.kind !== 'connection' || candidate?.kind !== 'connection' || !retainedProfileIds.has(profileId) || !isRecord(bindings)) {
        continue;
      }
      const moved = new Set(candidate.movedSecretBindingEnvironmentVariableNames ?? []);
      const remaining: Record<string, unknown> = Object.create(null);
      for (const [environmentVariableName, savedSecretId] of Object.entries(bindings)) {
        if (!moved.has(environmentVariableName)) remaining[environmentVariableName] = savedSecretId;
      }
      if (Object.keys(remaining).length > 0) {
        nextBindings[profileId] = remaining;
      }
    }
  }
  const nextEnabled: Record<string, unknown> = Object.create(null);
  if (isRecord(raw.profileEnabledById)) {
    for (const [profileId, value] of Object.entries(raw.profileEnabledById)) {
      if (!outcomeBySource.has(profileId)
        || dispositionBySource.get(profileId) !== 'migrate_legacy_state'
        || outcomeBySource.get(profileId)?.kind === 'skipped_disabled') {
        nextEnabled[profileId] = value;
      }
    }
  }

  const settings: RecordValue = {
    ...migrated.settings,
    ...(retainedProfiles.length > 0 || raw.profiles !== undefined ? { profiles: retainedProfiles } : {}),
    ...(raw.secretBindingsByProfileId !== undefined ? { secretBindingsByProfileId: nextBindings } : {}),
    ...(raw.profileEnabledById !== undefined ? { profileEnabledById: nextEnabled } : {}),
    ...(raw.favoriteProfiles !== undefined
      ? {
          favoriteProfiles: favoriteProfiles.filter((id) => {
            const outcome = outcomeBySource.get(id);
            return outcome === undefined
              || dispositionBySource.get(id) !== 'migrate_legacy_state'
              || outcome.kind === 'skipped_disabled';
          }),
        }
      : {}),
    ...(favoriteModelSelections.length > 0 ? { favoriteModelSelectionsV1: favoriteModelSelections } : {}),
    ...(lastUsedProfile !== null
      && outcomeBySource.has(lastUsedProfile)
      && dispositionBySource.get(lastUsedProfile) === 'migrate_legacy_state'
      ? { lastUsedProfile: retainedProfileIds.has(lastUsedProfile) ? lastUsedProfile : null }
      : {}),
  };
  return { ...migrated, settings };
}

export const LegacyProfileCredentialStyleV1Schema = z.enum(['bearer', 'x-api-key', 'api-key']);
export type LegacyProfileCredentialStyleV1 = z.infer<typeof LegacyProfileCredentialStyleV1Schema>;

export const LegacyProfileReviewedMappingV1Schema = z.object({
  connection: ProviderConnectionV1Schema.refine(
    (connection) => connection.source.kind === 'custom' && connection.role === 'named',
    'Guided legacy migration creates a named custom connection',
  ),
  credentialMoves: z.array(z.object({
    legacyEnvVarName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u).max(128),
    credentialSlotId: ProviderLocalIdSchema,
    credentialStyle: LegacyProfileCredentialStyleV1Schema,
  }).strict()).max(1),
  routingEnvironmentVariableNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u).max(128)).max(32).default([]),
  manualModelIds: z.array(ProviderModelIdSchema).max(500),
  selectedModel: z.object({
    agentTargetKey: ProviderAgentTargetKeySchema,
    modelId: ProviderModelIdSchema,
  }).strict().optional(),
}).strict().superRefine((mapping, ctx) => {
  if (mapping.credentialMoves.length === 0) return;
  if (mapping.connection.source.kind !== 'custom') return;
  const credential = mapping.connection.source.template.credential;
  for (const [index, move] of mapping.credentialMoves.entries()) {
    if (!credential || move.credentialSlotId !== credential.slotId) {
      ctx.addIssue({ code: 'custom', path: ['credentialMoves', index, 'credentialSlotId'], message: 'Credential move must target the reviewed custom credential slot' });
      continue;
    }
    const expected = move.credentialStyle === 'bearer'
      ? { name: 'authorization', format: 'bearer' as const }
      : { name: move.credentialStyle, format: 'raw' as const };
    if (!credential.transports.some((transport) =>
      transport.destination.kind === 'httpHeader'
      && transport.destination.name === expected.name
      && transport.destination.format === expected.format)) {
      ctx.addIssue({ code: 'custom', path: ['credentialMoves', index, 'credentialStyle'], message: 'Credential style must match a reviewed custom credential transport' });
    }
    if (move.legacyEnvVarName === 'ANTHROPIC_API_KEY' && move.credentialStyle !== 'x-api-key') {
      ctx.addIssue({ code: 'custom', path: ['credentialMoves', index, 'credentialStyle'], message: 'ANTHROPIC_API_KEY requires x-api-key style' });
    }
    if (/(?:AUTH|OAUTH)_TOKEN$/u.test(move.legacyEnvVarName) && move.credentialStyle !== 'bearer') {
      ctx.addIssue({ code: 'custom', path: ['credentialMoves', index, 'credentialStyle'], message: 'Authentication token variables require bearer style' });
    }
  }
});
export type LegacyProfileReviewedMappingV1 = z.infer<typeof LegacyProfileReviewedMappingV1Schema>;

function findRawProfile(rawSettings: Readonly<Record<string, unknown>>, sourceProfileId: string): unknown {
  const matches = (Array.isArray(rawSettings.profiles) ? rawSettings.profiles : []).filter((entry) =>
    isRecord(entry) && entry.id === sourceProfileId);
  if (matches.length !== 1) throw new LegacyProfileMigrationSourceNotFoundError(sourceProfileId);
  return matches[0];
}

export class LegacyProfileMigrationSourceNotFoundError extends Error {
  readonly sourceProfileId: string;

  constructor(sourceProfileId: string) {
    super('Legacy source profile must exist exactly once');
    this.name = 'LegacyProfileMigrationSourceNotFoundError';
    this.sourceProfileId = sourceProfileId;
  }
}

function readRawProfileBindings(
  rawSettings: Readonly<Record<string, unknown>>,
  sourceProfileId: string,
): Readonly<Record<string, unknown>> {
  const byProfile = rawSettings.secretBindingsByProfileId;
  if (!isRecord(byProfile)) return {};
  const bindings = byProfile[sourceProfileId];
  return isRecord(bindings) ? bindings : {};
}

export function createLegacyProfileMigrationSourceFingerprintV1(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
}>): string {
  const mapping = LegacyProfileReviewedMappingV1Schema.parse(input.reviewedMapping);
  const rawProfile = findRawProfile(input.rawSettings, input.sourceProfileId);
  const rawBindings = readRawProfileBindings(input.rawSettings, input.sourceProfileId);
  const relevantBindingIds = mapping.credentialMoves.map((move) => ({
    envVarName: move.legacyEnvVarName,
    savedSecretId: typeof rawBindings[move.legacyEnvVarName] === 'string' ? rawBindings[move.legacyEnvVarName] : null,
  }));
  const enabled = isRecord(input.rawSettings.profileEnabledById)
    && Object.prototype.hasOwnProperty.call(input.rawSettings.profileEnabledById, input.sourceProfileId)
    ? input.rawSettings.profileEnabledById[input.sourceProfileId]
    : null;
  return createProviderFingerprintV1('legacy-profile-migration-source', {
    sourceProfileId: input.sourceProfileId,
    rawProfile,
    relevantBindingIds,
    evidence: {
      lastUsed: input.rawSettings.lastUsedProfile === input.sourceProfileId,
      favorite: Array.isArray(input.rawSettings.favoriteProfiles) && input.rawSettings.favoriteProfiles.includes(input.sourceProfileId),
      enabled: typeof enabled === 'boolean' ? enabled : null,
    },
    reviewedMapping: mapping,
  });
}

export function confirmLegacyAiLaunchProfileMigrationV1(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
}>): LegacyAiLaunchProfilesMigrationResultV1 | Readonly<{
  ok: false;
  changed: false;
  settings: unknown;
  reason: 'legacy_profile_source_changed';
}> {
  let fingerprint: string;
  let mapping: LegacyProfileReviewedMappingV1;
  try {
    mapping = LegacyProfileReviewedMappingV1Schema.parse(input.reviewedMapping);
    fingerprint = createLegacyProfileMigrationSourceFingerprintV1(input);
  } catch {
    return { ok: false, changed: false, settings: input.rawSettings, reason: 'legacy_profile_source_changed' };
  }
  if (fingerprint !== input.expectedSourceFingerprint) {
    return { ok: false, changed: false, settings: input.rawSettings, reason: 'legacy_profile_source_changed' };
  }
  const rawBindings = readRawProfileBindings(input.rawSettings, input.sourceProfileId);
  const accountBindings: Record<string, string> = {};
  for (const move of mapping.credentialMoves) {
    const savedSecretId = rawBindings[move.legacyEnvVarName];
    if (!isCanonicalProviderSavedSecretIdV1(savedSecretId)) {
      return { ok: false, changed: false, settings: input.rawSettings, reason: 'legacy_profile_source_changed' };
    }
    accountBindings[move.credentialSlotId] = savedSecretId;
  }
  return migrateLegacyAiLaunchProfilesV1(input.rawSettings, {
    migratedAt: input.migratedAt,
    pendingCustomProfileIds: [],
    candidates: [{
      kind: 'connection',
      sourceProfileId: input.sourceProfileId,
      connection: mapping.connection,
      ...(Object.keys(accountBindings).length > 0 ? { secretBindings: { account: accountBindings } } : {}),
      manualModels: mapping.manualModelIds.map((id) => ({ id, addedAt: input.migratedAt })),
      ...(mapping.selectedModel ? { selectedModel: mapping.selectedModel } : {}),
      removedEnvironmentVariableNames: [
        ...mapping.routingEnvironmentVariableNames,
        ...mapping.credentialMoves.map((move) => move.legacyEnvVarName),
      ],
      movedSecretBindingEnvironmentVariableNames: mapping.credentialMoves.map((move) => move.legacyEnvVarName),
    }],
  });
}
