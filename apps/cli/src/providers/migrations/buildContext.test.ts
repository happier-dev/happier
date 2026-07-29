import { describe, expect, it } from 'vitest';

import { ProviderContributionV1Schema, migrateLegacyAiLaunchProfilesV1 } from '@happier-dev/protocol';

import { buildLegacyProfileMigrationContext } from './buildContext';

const contribution = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'frontier',
  endpointTemplates: [{
    id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' },
  }],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    transports: [{
      id: 'key', protocols: ['anthropic'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
    }],
  },
  catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] },
  legacyProfileMigrations: [{
    sourceProfileId: 'deepseek',
    descriptorRevision: 2,
    implicitModelAliasReplacements: [
      { legacyModelId: 'deepseek-chat', replacementModelId: 'deepseek-v4-flash' },
      { legacyModelId: 'deepseek-reasoner', replacementModelId: 'deepseek-v4-flash' },
    ],
    credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    primaryModel: {
      agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL',
      legacyProcessEnvAlias: 'DEEPSEEK_MODEL', defaultModelId: 'deepseek-v4-flash',
    },
    migratedEnvironmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
      { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-v4-flash}' },
    ],
    retainedEnvironmentVariables: [
      { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
      { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-v4-flash}' },
    ],
  }],
});

const registry = new Map([['happier.provider.deepseek/deepseek', { definition: contribution }]]);

describe('buildLegacyProfileMigrationContext', () => {
  it.each([
    ['deepseek', 'agent:claude', 'backend:claude'],
    ['zai', 'agent:claude', 'backend:claude'],
    ['openai', 'agent:codex', 'backend:codex'],
  ])('projects the bundled %s legacy target into the current Provider target identity', (
    sourceProfileId,
    legacyAgentTargetKey,
    expectedAgentTargetKey,
  ) => {
    const definition = ProviderContributionV1Schema.parse({
      ...contribution,
      id: sourceProfileId,
      legacyProfileMigrations: [{
        ...contribution.legacyProfileMigrations![0]!,
        sourceProfileId,
        retainedEnvironmentVariables: [],
        primaryModel: {
          ...contribution.legacyProfileMigrations![0]!.primaryModel!,
          agentTargetKey: legacyAgentTargetKey,
        },
      }],
    });
    const context = buildLegacyProfileMigrationContext({
      rawSettings: { favoriteProfiles: [sourceProfileId] },
      providersByContributionKey: new Map([[
        `happier.provider.${sourceProfileId}/${sourceProfileId}`,
        { definition },
      ]]),
      allocatedConnectionIdsBySourceProfileId: { [sourceProfileId]: `pc-${sourceProfileId}` },
      migratedAt: 20,
    });

    expect(context.candidates[0]).toMatchObject({
      kind: 'connection',
      sourceProfileId,
      selectedModel: { agentTargetKey: expectedAgentTargetKey },
    });
  });

  it('applies contribution-owned implicit alias replacements instead of requiring a pre-rewritten default', () => {
    const legacyDefaultContribution = ProviderContributionV1Schema.parse({
      ...contribution,
      legacyProfileMigrations: contribution.legacyProfileMigrations?.map((descriptor) => ({
        ...descriptor,
        primaryModel: descriptor.primaryModel
          ? { ...descriptor.primaryModel, defaultModelId: 'deepseek-reasoner' }
          : undefined,
      })),
    });
    const context = buildLegacyProfileMigrationContext({
      rawSettings: { favoriteProfiles: ['deepseek'] },
      providersByContributionKey: new Map([[
        'happier.provider.deepseek/deepseek',
        { definition: legacyDefaultContribution },
      ]]),
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates[0]).toMatchObject({
      selectedModelOrigin: 'implicit_default',
      selectedModel: { modelId: 'deepseek-v4-flash' },
    });
  });

  it('requires positive evidence, preserves the exact secret id, and derives plugin-owned model facts', () => {
    const none = buildLegacyProfileMigrationContext({
      rawSettings: { schemaVersion: 7 }, providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' }, migratedAt: 20,
    });
    expect(none.candidates).toEqual([]);

    const unrelatedBinding = buildLegacyProfileMigrationContext({
      rawSettings: { secretBindingsByProfileId: { deepseek: { UNRELATED_TOKEN: 'secret-id' } } },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(unrelatedBinding.candidates).toEqual([]);

    const context = buildLegacyProfileMigrationContext({
      rawSettings: {
        schemaVersion: 7,
        favoriteProfiles: ['deepseek'],
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'same-saved-secret-id' } },
      },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      processEnv: { DEEPSEEK_MODEL: 'deepseek-custom' },
      migratedAt: 20,
    });
    expect(context.candidates).toHaveLength(1);
    expect(context.candidates[0]).toMatchObject({
      kind: 'connection', sourceProfileId: 'deepseek',
      connection: { id: 'pc-deepseek', source: { contributionKey: 'happier.provider.deepseek/deepseek' } },
      secretBindings: { account: { apiKey: 'same-saved-secret-id' } },
      manualModels: [{ id: 'deepseek-custom' }],
      selectedModel: { agentTargetKey: 'backend:claude', modelId: 'deepseek-custom' },
      sourceRevision: 2,
      selectedModelOrigin: 'explicit_process_environment',
      retainedLaunchProfile: {
        v: 2,
        extraEnvironmentVariables: expect.arrayContaining([
          { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
        ]),
      },
    });
  });

  it('migrates deterministic defaults to the verified replacement while preserving explicit retired aliases as stale', () => {
    const implicit = buildLegacyProfileMigrationContext({
      rawSettings: { favoriteProfiles: ['deepseek'] },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(implicit.candidates[0]).toMatchObject({
      kind: 'connection',
      sourceRevision: 2,
      selectedModelOrigin: 'implicit_default',
      manualModels: [{ id: 'deepseek-v4-flash' }],
      selectedModel: { modelId: 'deepseek-v4-flash' },
    });

    const explicit = buildLegacyProfileMigrationContext({
      rawSettings: { favoriteProfiles: ['deepseek'] },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      processEnv: { DEEPSEEK_MODEL: 'deepseek-reasoner' },
      migratedAt: 20,
    });
    expect(explicit.candidates[0]).toMatchObject({
      kind: 'connection',
      sourceRevision: 2,
      selectedModelOrigin: 'explicit_process_environment',
      selectedModel: { modelId: 'deepseek-reasoner' },
    });
    expect(explicit.candidates[0]).not.toHaveProperty('manualModels');
  });

  it('threads the implicit replacement through completion provenance, favorite, and retained slim-profile defaults', () => {
    const rawSettings = {
      favoriteProfiles: ['deepseek'],
      lastUsedProfile: 'deepseek',
    };
    const context = buildLegacyProfileMigrationContext({
      rawSettings,
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    const migrated = migrateLegacyAiLaunchProfilesV1(rawSettings, context);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error('expected migration');
    expect(migrated.settings).toMatchObject({
      providerSettingsV1: {
        migration: {
          completedSources: [{
            sourceProfileId: 'deepseek', sourceRevision: 2,
            modelSelectionOrigin: 'implicit_default',
            modelSelection: { agentTargetKey: 'backend:claude', modelId: 'deepseek-v4-flash' },
          }],
        },
      },
      favoriteModelSelectionsV1: [{ selection: { ref: { agentTargetKey: 'backend:claude', modelId: 'deepseek-v4-flash' } } }],
      profiles: [{
        id: 'deepseek',
        preferredModelSelection: { ref: { agentTargetKey: 'backend:claude', modelId: 'deepseek-v4-flash' } },
        extraEnvironmentVariables: expect.arrayContaining([
          { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-v4-flash}' },
        ]),
      }],
    });
  });

  it('repairs already-completed current-Dev Provider outputs without replacing connection or secret identity', () => {
    const rawSettings = {
      favoriteProfiles: ['deepseek'],
      lastUsedProfile: 'deepseek',
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'same-saved-secret-id' } },
    };
    const legacyContext = buildLegacyProfileMigrationContext({
      rawSettings,
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    const legacyWritten = migrateLegacyAiLaunchProfilesV1(rawSettings, {
      ...legacyContext,
      candidates: legacyContext.candidates.map((candidate) => candidate.kind === 'connection'
        ? {
            ...candidate,
            selectedModel: candidate.selectedModel
              ? { ...candidate.selectedModel, agentTargetKey: 'agent:claude' }
              : undefined,
          }
        : candidate),
    });
    expect(legacyWritten.ok).toBe(true);
    if (!legacyWritten.ok) throw new Error('expected legacy current-Dev output');

    const repairContext = buildLegacyProfileMigrationContext({
      rawSettings: legacyWritten.settings,
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-must-not-replace' },
      migratedAt: 30,
    });
    const repaired = migrateLegacyAiLaunchProfilesV1(legacyWritten.settings, repairContext);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected current-Dev repair');
    expect(repaired.changed).toBe(true);
    expect(repaired.settings).toMatchObject({
      providerSettingsV1: {
        connections: [{ id: 'pc-deepseek' }],
        secretBindingsByConnectionId: {
          'pc-deepseek': { account: { apiKey: 'same-saved-secret-id' } },
        },
        migration: { completedSources: [{
          sourceProfileId: 'deepseek',
          connectionId: 'pc-deepseek',
          modelSelection: {
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc-deepseek',
          },
        }] },
      },
      favoriteModelSelectionsV1: [{ selection: { ref: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc-deepseek',
      } } }],
      profiles: [{
        id: 'deepseek',
        preferredModelSelection: { ref: { agentTargetKey: 'backend:claude' } },
      }],
    });
  });

  it('repairs only Provider-owned outputs when the completed source now has an opaque future Profile row', () => {
    const initialSettings = {
      favoriteProfiles: ['deepseek'],
      lastUsedProfile: 'deepseek',
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'same-saved-secret-id' } },
    };
    const initialContext = buildLegacyProfileMigrationContext({
      rawSettings: initialSettings,
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    const legacyWritten = migrateLegacyAiLaunchProfilesV1(initialSettings, {
      ...initialContext,
      candidates: initialContext.candidates.map((candidate) => candidate.kind === 'connection'
        ? {
            ...candidate,
            selectedModel: candidate.selectedModel
              ? { ...candidate.selectedModel, agentTargetKey: 'agent:claude' }
              : undefined,
          }
        : candidate),
    });
    expect(legacyWritten.ok).toBe(true);
    if (!legacyWritten.ok) throw new Error('expected legacy current-Dev output');

    const opaqueProfile = {
      v: 99,
      id: 'deepseek',
      opaque: { preserve: ['future', 'profile', 'bytes'] },
    };
    const legacySidecars = {
      favoriteProfiles: ['deepseek', 'future-favorite'],
      secretBindingsByProfileId: {
        deepseek: {
          DEEPSEEK_AUTH_TOKEN: 'legacy-sidecar-secret',
          FUTURE_TOKEN: 'future-sidecar-secret',
        },
        'future-profile': { FUTURE_TOKEN: 'unrelated-secret' },
      },
      profileEnabledById: { deepseek: true, 'future-profile': { enabled: 'maybe' } },
      lastUsedProfile: 'deepseek',
    } as const;
    const repairInput = {
      ...legacyWritten.settings,
      ...legacySidecars,
      profiles: [opaqueProfile],
      opaqueTopLevel: { preserve: true },
    };
    const repairContext = buildLegacyProfileMigrationContext({
      rawSettings: repairInput,
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-must-not-replace' },
      migratedAt: 30,
    });
    const repaired = migrateLegacyAiLaunchProfilesV1(repairInput, repairContext);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected opaque Profile repair');

    expect(repaired.changed).toBe(true);
    expect(repaired.settings.profiles).toEqual([opaqueProfile]);
    expect(repaired.settings.favoriteProfiles).toEqual(legacySidecars.favoriteProfiles);
    expect(repaired.settings.secretBindingsByProfileId).toEqual(legacySidecars.secretBindingsByProfileId);
    expect(repaired.settings.profileEnabledById).toEqual(legacySidecars.profileEnabledById);
    expect(repaired.settings.lastUsedProfile).toBe(legacySidecars.lastUsedProfile);
    expect(repaired.settings.opaqueTopLevel).toEqual({ preserve: true });
    expect(repaired.settings).toMatchObject({
      providerSettingsV1: {
        connections: [{ id: 'pc-deepseek' }],
        secretBindingsByConnectionId: {
          'pc-deepseek': { account: { apiKey: 'same-saved-secret-id' } },
        },
        migration: { completedSources: [{
          sourceProfileId: 'deepseek',
          connectionId: 'pc-deepseek',
          modelSelection: {
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc-deepseek',
          },
        }] },
      },
      favoriteModelSelectionsV1: [{ selection: { ref: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc-deepseek',
      } } }],
    });
  });

  it.each([
    [' padded ', 'padded'],
    ['control\u0000id', 'control'],
    ['x'.repeat(257), 'oversized'],
  ])('does not treat a malformed %s SavedSecret id as migration evidence', (savedSecretId) => {
    const context = buildLegacyProfileMigrationContext({
      rawSettings: {
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: savedSecretId } },
      },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates).toEqual([]);
  });

  it('does not read inherited profile or environment binding properties as evidence', () => {
    const inheritedEnvironmentBinding = Object.create({ DEEPSEEK_AUTH_TOKEN: 'inherited-secret' });
    const inheritedProfileBindings = Object.create({ deepseek: inheritedEnvironmentBinding });
    const context = buildLegacyProfileMigrationContext({
      rawSettings: { secretBindingsByProfileId: inheritedProfileBindings },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates).toEqual([]);
  });

  it('records explicit false as terminal skipped intent and recognizes historical placeholders', () => {
    const context = buildLegacyProfileMigrationContext({
      rawSettings: {
        schemaVersion: 6,
        profileEnabledById: { deepseek: false },
        favoriteProfiles: ['gemini'],
      },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates).toEqual([
      { kind: 'skipped_disabled', sourceProfileId: 'deepseek' },
      { kind: 'default_environment', sourceProfileId: 'gemini' },
    ]);
  });

  it('does not auto-migrate a deterministic id whose persisted source row is opaque or future-versioned', () => {
    const context = buildLegacyProfileMigrationContext({
      rawSettings: {
        profiles: [{ v: 99, id: 'deepseek', payload: { preserve: true } }],
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'same-saved-secret-id' } },
      },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates).toEqual([]);
    expect(context.pendingCustomProfileIds).toEqual([]);
  });

  it('leaves an edited built-in legacy row untouched unless every environment row has an explicit safe disposition', () => {
    const base = {
      id: 'deepseek', name: 'DeepSeek', createdAt: 1, updatedAt: 1,
      environmentVariables: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://user-edited.example' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
        { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-reasoner}' },
        { name: 'EXTRA_ROUTING_ENDPOINT', value: 'https://other.example' },
      ],
      envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
    };
    const context = buildLegacyProfileMigrationContext({
      rawSettings: { profiles: [base], lastUsedProfile: 'deepseek' },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.candidates).toEqual([]);
  });

  it('marks routing-like custom profiles pending without inferring a protocol or connection', () => {
    const context = buildLegacyProfileMigrationContext({
      rawSettings: {
        profiles: [{
          id: 'company', name: 'Company',
          environmentVariables: [{ name: 'OPENAI_API_URL', value: 'https://company.example/v1' }],
          createdAt: 1, updatedAt: 1,
        }],
        lastUsedProfile: 'company',
      },
      providersByContributionKey: registry,
      allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' },
      migratedAt: 20,
    });
    expect(context.pendingCustomProfileIds).toEqual(['company']);
    expect(context.candidates).toEqual([]);
  });
});
