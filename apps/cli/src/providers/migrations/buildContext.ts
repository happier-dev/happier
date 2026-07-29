import {
  AIBackendProfileSchema,
  buildBackendTargetKeyV2,
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  ProviderConnectionIdSchema,
  ProviderModelIdSchema,
  ProviderSettingsMigrationSourceOutcomeV1Schema,
  LaunchProfileV2Schema,
  isLegacyAiLaunchEndpointLikeEnvironmentNameV1,
  isCanonicalProviderSavedSecretIdV1,
  compareProviderCanonicalStringsV1,
  readBackendTargetRefV2,
  type ProviderAccountSettingsMigrationCandidateV1,
  type ProviderAccountSettingsMigrationContextV1,
  type ProviderContributionV1,
} from '@happier-dev/protocol';

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

function hasNonLegacyPersistedSourceRow(raw: Readonly<Record<string, unknown>>, sourceProfileId: string): boolean {
  if (!Array.isArray(raw.profiles)) return false;
  const matches = raw.profiles.filter((entry) => isRecord(entry) && own(entry, 'id') === sourceProfileId);
  if (matches.length === 0) return false;
  return matches.length !== 1 || !AIBackendProfileSchema.safeParse(matches[0]).success;
}

function readPersistedLegacyProfile(
  raw: Readonly<Record<string, unknown>>,
  sourceProfileId: string,
): ReturnType<typeof AIBackendProfileSchema.safeParse> | null {
  if (!Array.isArray(raw.profiles)) return null;
  const matches = raw.profiles.filter((entry) => isRecord(entry) && own(entry, 'id') === sourceProfileId);
  return matches.length === 1 ? AIBackendProfileSchema.safeParse(matches[0]) : null;
}

function isPersistedProfileDispositionComplete(
  profile: ReturnType<typeof AIBackendProfileSchema.parse>,
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

function profileReferenceEvidence(raw: Readonly<Record<string, unknown>>, sourceProfileId: string): boolean {
  if (raw.lastUsedProfile === sourceProfileId) return true;
  if (stringArray(raw.favoriteProfiles).includes(sourceProfileId)) return true;
  const enabled = isRecord(raw.profileEnabledById) ? own(raw.profileEnabledById, sourceProfileId) : undefined;
  if (enabled === true) return true;
  return false;
}

function readCompletedConnectionOutcome(
  raw: Readonly<Record<string, unknown>>,
  sourceProfileId: string,
) {
  const providerSettings = isRecord(own(raw, 'providerSettingsV1')) ? own(raw, 'providerSettingsV1') : undefined;
  const migration = isRecord(providerSettings) && isRecord(own(providerSettings, 'migration'))
    ? own(providerSettings, 'migration')
    : undefined;
  const completedSources = isRecord(migration) && Array.isArray(own(migration, 'completedSources'))
    ? own(migration, 'completedSources')
    : [];
  for (const entry of completedSources as readonly unknown[]) {
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

const DEFAULT_ENVIRONMENT_PROFILE_IDS = Object.freeze(['anthropic', 'codex', 'gemini']);

export function buildLegacyProfileMigrationContext(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  providersByContributionKey: ReadonlyMap<string, ProviderContributionEntry>;
  allocatedConnectionIdsBySourceProfileId: Readonly<Record<string, string>>;
  migratedAt: number;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): ProviderAccountSettingsMigrationContextV1 {
  const candidates: ProviderAccountSettingsMigrationCandidateV1[] = [];
  const knownSourceIds = new Set<string>([
    ...DEFAULT_ENVIRONMENT_PROFILE_IDS,
    ...DEFAULT_BUILT_IN_BACKEND_PROFILES.map((profile) => profile.id),
  ]);

  for (const sourceProfileId of DEFAULT_ENVIRONMENT_PROFILE_IDS) {
    if (profileReferenceEvidence(input.rawSettings, sourceProfileId)) {
      candidates.push({ kind: 'default_environment', sourceProfileId });
    }
  }

  for (const [contributionKey, entry] of input.providersByContributionKey) {
    for (const descriptor of entry.definition.legacyProfileMigrations ?? []) {
      const sourceProfileId = descriptor.sourceProfileId;
      knownSourceIds.add(sourceProfileId);
      const completedOutcome = readCompletedConnectionOutcome(input.rawSettings, sourceProfileId);
      // Built-ins historically need not be persisted at all. When a row is
      // present, however, only the exact legacy schema is safe to transform;
      // opaque/future/duplicate rows remain byte-for-byte legacy state. A known
      // completed Provider source may still repair its Provider-owned output;
      // the profile loop independently preserves any opaque row.
      if (hasNonLegacyPersistedSourceRow(input.rawSettings, sourceProfileId) && completedOutcome === null) continue;
      const persisted = readPersistedLegacyProfile(input.rawSettings, sourceProfileId);
      if (completedOutcome === null
        && persisted
        && (!persisted.success || !isPersistedProfileDispositionComplete(persisted.data, descriptor))) continue;
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
      if (!profileReferenceEvidence(input.rawSettings, sourceProfileId)
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
      const retainedEnvironmentVariables = persisted?.success
        ? persisted.data.environmentVariables.filter((entry) =>
            descriptor.retainedEnvironmentVariables.some((retained) => retained.name === entry.name))
        : descriptor.retainedEnvironmentVariables;
      const retainedRequirements = persisted?.success
        ? persisted.data.envVarRequirements.filter((entry) =>
            descriptor.retainedEnvironmentVariables.some((retained) => retained.name === entry.name))
        : [];
      const retainedLaunchProfile = retainedEnvironmentVariables.length > 0 || retainedRequirements.length > 0
        ? LaunchProfileV2Schema.parse({
            v: 2,
            id: sourceProfileId,
            name: entry.definition.name,
            extraEnvironmentVariables: retainedEnvironmentVariables,
            envVarRequirements: retainedRequirements,
            defaultPermissionModeByTargetKey: persisted?.success ? persisted.data.defaultPermissionModeByTargetKey : {},
            defaultPersistenceModeByTargetKey: persisted?.success ? persisted.data.defaultPersistenceModeByTargetKey : {},
            compatibilityByTargetKey: descriptor.primaryModel ? { [descriptor.primaryModel.agentTargetKey]: true } : {},
            createdAt: persisted?.success ? persisted.data.createdAt : input.migratedAt,
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
        removedEnvironmentVariableNames: [
          ...descriptor.migratedEnvironmentVariables.map((environment) => environment.name),
          ...(descriptor.credentialBinding ? [descriptor.credentialBinding.legacyEnvVarName] : []),
        ],
        ...(descriptor.credentialBinding ? {
          movedSecretBindingEnvironmentVariableNames: [descriptor.credentialBinding.legacyEnvVarName],
        } : {}),
        ...(retainedLaunchProfile ? { retainedLaunchProfile } : {}),
      });
    }
  }

  const pendingCustomProfileIds: string[] = [];
  if (Array.isArray(input.rawSettings.profiles)) {
    for (const rawProfile of input.rawSettings.profiles) {
      const parsed = AIBackendProfileSchema.safeParse(rawProfile);
      if (!parsed.success || knownSourceIds.has(parsed.data.id)) continue;
      const routingLike = parsed.data.environmentVariables.some((entry) =>
        isLegacyAiLaunchEndpointLikeEnvironmentNameV1(entry.name));
      if (routingLike && profileReferenceEvidence(input.rawSettings, parsed.data.id)) {
        pendingCustomProfileIds.push(parsed.data.id);
      }
    }
  }

  candidates.sort((left, right) => compareProviderCanonicalStringsV1(left.sourceProfileId, right.sourceProfileId));
  pendingCustomProfileIds.sort(compareProviderCanonicalStringsV1);
  return { migratedAt: input.migratedAt, candidates, pendingCustomProfileIds };
}
