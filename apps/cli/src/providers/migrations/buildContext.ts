import type { AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { readAiLaunchProfileCollection } from '@happier-dev/protocol/profiles/read';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { DEFAULT_BUILT_IN_BACKEND_PROFILES } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { ProviderConnectionIdSchema, ProviderModelIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderSettingsMigrationSourceOutcomeV1Schema, isCanonicalProviderSavedSecretIdV1 } from '@happier-dev/protocol/providers/settings/v1';
import { isLegacyAiLaunchEndpointLikeEnvironmentNameV1 } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import { compareProviderCanonicalStringsV1 } from '@happier-dev/protocol/providers/canonicalOrderV1';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ProviderAccountSettingsMigrationCandidateV1, ProviderAccountSettingsMigrationContextV1, ProviderContributionV1, ProviderSettingsV1 } from '@happier-dev/protocol';

type ProviderContributionEntry = Readonly<{ definition: ProviderContributionV1 }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(record: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readPersistedSourceProfile(
  profiles: ReturnType<typeof readAiLaunchProfileCollection>['entries'],
  sourceProfileId: string,
) {
  const matches = profiles.filter((entry) => isRecord(entry.raw) && own(entry.raw, 'id') === sourceProfileId);
  if (matches.length === 0) return { kind: 'absent' } as const;
  const source = matches[0];
  return matches.length === 1 && source?.kind === 'legacy'
    ? { kind: 'legacy', profile: source.profile } as const
    : { kind: 'nonlegacy' } as const;
}

function isPersistedProfileDispositionComplete(
  profile: AIBackendProfile,
  descriptor: NonNullable<ProviderContributionV1['legacyProfileMigrations']>[number],
): boolean {
  const migrated = new Map(descriptor.migratedEnvironmentVariables.map((entry) => [entry.name, entry.value]));
  const retained = new Set(descriptor.retainedEnvironmentVariables.map((entry) => entry.name));
  for (const [name, expectedValue] of migrated) {
    if (!profile.environmentVariables.some((entry) => entry.name === name && entry.value === expectedValue)) return false;
  }
  if (profile.environmentVariables.some((entry) => {
    const expected = migrated.get(entry.name);
    return expected === undefined ? !retained.has(entry.name) : entry.value !== expected;
  })) return false;
  const credentialName = descriptor.credentialBinding?.legacyEnvVarName;
  return profile.envVarRequirements.every((entry) => entry.name === credentialName || retained.has(entry.name));
}

function profileReferenceEvidence(raw: Readonly<Record<string, unknown>>, sourceProfileId: string, lastUsedProfile: string | null): boolean {
  if (lastUsedProfile === sourceProfileId) return true;
  if (stringArray(raw.favoriteProfiles).includes(sourceProfileId)) return true;
  const enabled = isRecord(raw.profileEnabledById) ? own(raw.profileEnabledById, sourceProfileId) : undefined;
  if (enabled === true) return true;
  return false;
}

function readCompletedConnectionOutcome(
  settings: ProviderSettingsV1,
  sourceProfileId: string,
) {
  for (const entry of settings.migration?.completedSources ?? []) {
    const parsed = ProviderSettingsMigrationSourceOutcomeV1Schema.safeParse(entry);
    if (parsed.success && parsed.data.sourceProfileId === sourceProfileId && parsed.data.kind === 'connection') {
      return parsed.data;
    }
  }
  return null;
}

function canonicalAgentTargetKey(agentTargetKey: string): string {
  return buildBackendTargetKeyV2(readBackendTargetRefV2(agentTargetKey));
}

function exactSecretBinding(
  raw: Readonly<Record<string, unknown>>,
  sourceProfileId: string,
  envName: string,
): string | null {
  const byProfile = isRecord(raw.secretBindingsByProfileId) ? own(raw.secretBindingsByProfileId, sourceProfileId) : undefined;
  const value = isRecord(byProfile) ? own(byProfile, envName) : undefined;
  return isCanonicalProviderSavedSecretIdV1(value) ? value : null;
}

// Historical default-profile vocabulary consumed by migrations/coordinator and migrations/runtime
// through buildLegacyProfileMigrationContext. Together with each contribution's
// legacyProfileMigrations it decodes prior profile intent; it is not a current
// Agent roster and must not grow from current plugin declarations.
const DEFAULT_ENVIRONMENT_PROFILE_IDS = Object.freeze(['anthropic', 'codex', 'gemini']);

export function buildLegacyProfileMigrationContext(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  providerSettings: ProviderSettingsV1;
  authoringMemory: Readonly<{ lastUsedProfile: string | null }>;
  providersByContributionKey: ReadonlyMap<string, ProviderContributionEntry>;
  allocatedConnectionIdsBySourceProfileId: Readonly<Record<string, string>>;
  migratedAt: number;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): ProviderAccountSettingsMigrationContextV1 {
  const candidates: ProviderAccountSettingsMigrationCandidateV1[] = [];
  const persistedProfiles = readAiLaunchProfileCollection(input.rawSettings.profiles).entries;
  const knownSourceIds = new Set<string>([
    ...DEFAULT_ENVIRONMENT_PROFILE_IDS,
    ...DEFAULT_BUILT_IN_BACKEND_PROFILES.map((profile) => profile.id),
  ]);

  for (const sourceProfileId of DEFAULT_ENVIRONMENT_PROFILE_IDS) {
    if (profileReferenceEvidence(input.rawSettings, sourceProfileId, input.authoringMemory.lastUsedProfile)) {
      candidates.push({ kind: 'default_environment', sourceProfileId });
    }
  }

  for (const [contributionKey, entry] of input.providersByContributionKey) {
    for (const descriptor of entry.definition.legacyProfileMigrations ?? []) {
      const sourceProfileId = descriptor.sourceProfileId;
      knownSourceIds.add(sourceProfileId);
      const completedOutcome = readCompletedConnectionOutcome(input.providerSettings, sourceProfileId);
      // Built-ins historically need not be persisted at all. When a row is
      // present, however, only the canonical legacy projection is safe to transform;
      // opaque/future/duplicate rows remain byte-for-byte legacy state. A known
      // completed Provider source may still repair its Provider-owned output;
      // the profile loop independently preserves any opaque row.
      const source = readPersistedSourceProfile(persistedProfiles, sourceProfileId);
      if (source.kind === 'nonlegacy' && completedOutcome === null) continue;
      const persisted = source.kind === 'legacy' ? source.profile : null;
      if (completedOutcome === null
        && persisted
        && !isPersistedProfileDispositionComplete(persisted, descriptor)) continue;
      const enabled = isRecord(input.rawSettings.profileEnabledById)
        ? own(input.rawSettings.profileEnabledById, sourceProfileId)
        : undefined;
      if (enabled === false) {
        candidates.push({ kind: 'skipped_disabled', sourceProfileId });
        continue;
      }
      const secretId = descriptor.credentialBinding
        ? exactSecretBinding(input.rawSettings, sourceProfileId, descriptor.credentialBinding.legacyEnvVarName)
        : null;
      const repairableCompletedSelection = descriptor.primaryModel
        && completedOutcome?.modelSelection
        && canonicalAgentTargetKey(completedOutcome.modelSelection.agentTargetKey)
          === canonicalAgentTargetKey(descriptor.primaryModel.agentTargetKey)
        ? completedOutcome.modelSelection
        : null;
      if (!profileReferenceEvidence(input.rawSettings, sourceProfileId, input.authoringMemory.lastUsedProfile)
        && secretId === null
        && repairableCompletedSelection === null) continue;
      const connectionId = ProviderConnectionIdSchema.parse(
        completedOutcome?.connectionId ?? own(input.allocatedConnectionIdsBySourceProfileId, sourceProfileId),
      );
      const aliasValue = descriptor.primaryModel?.legacyProcessEnvAlias
        ? input.processEnv?.[descriptor.primaryModel.legacyProcessEnvAlias]?.trim()
        : undefined;
      const hasExplicitModelAlias = Boolean(aliasValue && ProviderModelIdSchema.safeParse(aliasValue).success);
      const implicitDefaultModelId = descriptor.primaryModel
        ? descriptor.implicitModelAliasReplacements.find((replacement) =>
            replacement.legacyModelId === descriptor.primaryModel?.defaultModelId)?.replacementModelId
          ?? descriptor.primaryModel.defaultModelId
        : undefined;
      const selectedModelId = repairableCompletedSelection?.modelId
        ?? (hasExplicitModelAlias ? aliasValue : implicitDefaultModelId);
      const explicitRetiredModelAlias = hasExplicitModelAlias
        && descriptor.implicitModelAliasReplacements.some((replacement) => replacement.legacyModelId === selectedModelId);
      const retainedEnvironmentVariables = persisted
        ? persisted.environmentVariables.filter((entry) =>
            descriptor.retainedEnvironmentVariables.some((retained) => retained.name === entry.name))
        : descriptor.retainedEnvironmentVariables;
      const retainedRequirements = persisted
        ? persisted.envVarRequirements.filter((entry) =>
            descriptor.retainedEnvironmentVariables.some((retained) => retained.name === entry.name))
        : [];
      const retainedLaunchProfile = retainedEnvironmentVariables.length > 0 || retainedRequirements.length > 0
        ? LaunchProfileV2Schema.parse({
            v: 2,
            id: sourceProfileId,
            name: entry.definition.name,
            extraEnvironmentVariables: retainedEnvironmentVariables,
            envVarRequirements: retainedRequirements,
            defaultPermissionModeByTargetKey: persisted ? persisted.defaultPermissionModeByTargetKey : {},
            defaultPersistenceModeByTargetKey: persisted ? persisted.defaultPersistenceModeByTargetKey : {},
            compatibilityByTargetKey: descriptor.primaryModel ? { [descriptor.primaryModel.agentTargetKey]: true } : {},
            createdAt: persisted ? persisted.createdAt : input.migratedAt,
            updatedAt: input.migratedAt,
          })
        : undefined;
      candidates.push({
        kind: 'connection',
        sourceProfileId,
        connection: {
          v: 1,
          id: connectionId,
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: entry.definition.name,
          displayNameMode: 'automatic',
          deployment: { kind: 'external' },
          revision: 0,
          createdAt: input.migratedAt,
          updatedAt: input.migratedAt,
        },
        ...(secretId && descriptor.credentialBinding
          ? { secretBindings: { account: { [descriptor.credentialBinding.credentialSlotId]: secretId } } }
          : {}),
        ...(descriptor.primaryModel && selectedModelId ? {
          ...(!explicitRetiredModelAlias ? { manualModels: [{ id: selectedModelId, addedAt: input.migratedAt }] } : {}),
          selectedModel: {
            agentTargetKey: canonicalAgentTargetKey(descriptor.primaryModel.agentTargetKey),
            modelId: selectedModelId,
          },
          sourceRevision: descriptor.descriptorRevision,
          selectedModelOrigin: completedOutcome?.modelSelectionOrigin
            ?? (hasExplicitModelAlias ? 'explicit_process_environment' : 'implicit_default'),
        } : {}),
        removedEnvironmentVariableNames: [...new Set([
          ...descriptor.migratedEnvironmentVariables.map((environment) => environment.name),
          ...(descriptor.credentialBinding ? [descriptor.credentialBinding.legacyEnvVarName] : []),
        ])],
        ...(descriptor.credentialBinding ? {
          movedSecretBindingEnvironmentVariableNames: [descriptor.credentialBinding.legacyEnvVarName],
        } : {}),
        ...(retainedLaunchProfile ? { retainedLaunchProfile } : {}),
      });
    }
  }

  const pendingCustomProfileIds: string[] = [];
  for (const entry of persistedProfiles) {
    if (entry.kind !== 'legacy' || knownSourceIds.has(entry.profile.id)) continue;
    const profile = entry.profile;
    const routingLike = profile.environmentVariables.some((entry) =>
      isLegacyAiLaunchEndpointLikeEnvironmentNameV1(entry.name));
    if (routingLike && profileReferenceEvidence(input.rawSettings, profile.id, input.authoringMemory.lastUsedProfile)) {
      pendingCustomProfileIds.push(profile.id);
    }
  }

  candidates.sort((left, right) => compareProviderCanonicalStringsV1(left.sourceProfileId, right.sourceProfileId));
  pendingCustomProfileIds.sort(compareProviderCanonicalStringsV1);
  return { migratedAt: input.migratedAt, candidates, pendingCustomProfileIds };
}
