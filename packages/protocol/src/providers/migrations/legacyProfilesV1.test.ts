import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '../../profiles/backendProfileSchema.js';
import { ProfileRecordV1Schema } from '../../profiles/profileRecordV1.js';
import { LaunchProfileV2Schema } from '../../profiles/v2/schema.js';
import { normalizeBackendTargetKeyV2Input } from '../../backends/targets/backendTargetRefV2.js';
import { getBuiltInBackendProfile } from '../../profiles/builtInBackendProfiles.js';
import { createProfileDuplicateDraftV1 } from '../../profiles/profileOperations.js';
import { readAiLaunchProfileRecords } from '../../profiles/read.js';
import { LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1 } from '../../profiles/v2/schema.js';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '../settings/v1.js';

import {
  confirmLegacyAiLaunchProfileMigrationV1,
  createLegacyProfileMigrationSourceFingerprintV1,
  LegacyProfileReviewedMappingV1Schema,
  migrateLegacyAiLaunchProfilesV1,
  listLegacyAiLaunchProfileCredentialEnvironmentVariableNamesV1,
  listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1,
  requiresLegacyAiLaunchProfileProviderSourcePreparationV1,
} from './legacyProfilesV1.js';

function connectionCandidate(sourceProfileId: string, connectionId: string, secretId = 'secret-a') {
  return {
    kind: 'connection' as const,
    sourceProfileId,
    connection: {
      v: 1 as const,
      id: connectionId,
      source: { kind: 'contribution' as const, contributionKey: 'happier.provider.deepseek/deepseek' },
      role: 'default' as const,
      displayName: 'DeepSeek',
      displayNameMode: 'automatic' as const,
      revision: 0,
      createdAt: 10,
      updatedAt: 10,
    },
    secretBindings: { account: { apiKey: secretId } },
    manualModels: [{ id: 'deepseek-reasoner', addedAt: 10 }],
    selectedModel: { agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner' },
    movedSecretBindingEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
    removedEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
  };
}

it.each(['azure-openai', 'gemini-api-key', 'gemini-vertex'])('duplicates the actual %s preset only after the incumbent Provider translator produces current selection', id => {
  const preset = getBuiltInBackendProfile(id);
  if (!preset) throw new Error('Expected a current routing preset');
  const source = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'legacy', profile: preset },
    enabled: false, promptStack: [], secretBindings: { MASKED: null } });
  const before = readAiLaunchProfileRecords([source], { artifactsById: new Map(), recordRevisionsById: new Map([[id, 8]]) }).entries[0];
  if (!before || before.kind === 'opaque') throw new Error('Expected the current preset source');
  expect(createProfileDuplicateDraftV1({ profile: before.profile, sourceRow: { record: source, revision: 8 },
    newProfileId: `${id}-copy`, name: 'Copy', now: 30 })).toMatchObject({ status: 'invalid', reason: 'legacy-creation-unsupported' });
  const agentTargetKey = id === 'azure-openai' ? 'agent:codex' : 'agent:gemini';
  const removed = [...new Set([...preset.environmentVariables.map(variable => variable.name),
    ...preset.envVarRequirements.map(requirement => requirement.name)])].filter(name => LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1.has(name));
  const result = migrateLegacyAiLaunchProfilesV1({ profiles: [preset] }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, pendingCustomProfileIds: [], candidates: [{
    kind: 'connection', sourceProfileId: id, connection: { v: 1, id: 'pc-converted',
      source: { kind: 'contribution', contributionKey: id === 'azure-openai' ? 'happier.provider.openai/openai' : 'happier.provider.google/google' },
      role: 'default', displayName: preset.name, displayNameMode: 'automatic', revision: 0, createdAt: 20, updatedAt: 20 },
    selectedModel: { agentTargetKey, modelId: 'selected-model' }, removedEnvironmentVariableNames: removed,
  }] }, { lastUsedProfile: null }, { profileRecordIds: [id], records: [{ record: source, revision: 8 }] });
  if (!result.ok || !Array.isArray(result.settings.profiles)) throw new Error('Expected accepted Provider translation');
  const converted = ProfileRecordV1Schema.parse({ ...source, definition: { kind: 'inline', profile: result.settings.profiles[0] } });
  const after = readAiLaunchProfileRecords([converted], { artifactsById: new Map(), recordRevisionsById: new Map([[id, 9]]) }).entries[0];
  if (!after || after.kind !== 'slim') throw new Error('Expected acknowledged current source');
  const draft = createProfileDuplicateDraftV1({ profile: after.profile, sourceRow: { record: converted, revision: 9 },
    newProfileId: `${id}-copy`, name: 'Copy', now: 30 });
  expect(draft).toMatchObject({ status: 'draft', secretBindings: source.secretBindings, profile: { v: 2, enabled: false,
    preferredModelSelection: { ref: { agentTargetKey: normalizeBackendTargetKeyV2Input(agentTargetKey), providerConnectionId: 'pc-converted', modelId: 'selected-model' } },
    extraEnvironmentVariables: preset.environmentVariables.filter(variable => !removed.includes(variable.name)) } });
});

describe('migrateLegacyAiLaunchProfilesV1', () => {
  it('preserves an existing private long untrimmed legacy identity and predecessor environment counts after accepted Provider conversion', () => {
    const id = `  retained-${'x'.repeat(270)}  `;
    const publicEnvironment = Array.from({ length: 257 }, (_, index) => ({ name: `TEAM_FLAG_${index}`, value: `public-${index}` }));
    const publicRequirements = publicEnvironment.map(({ name }) => ({ name, kind: 'config' as const, required: true }));
    const profile = AIBackendProfileSchema.parse({ id, name: '  Retained company profile  ', description: 'd'.repeat(500),
      environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, ...publicEnvironment],
      envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }, ...publicRequirements],
      defaultPermissionModeByTargetKey: { 'agent:claude': 'default' },
      defaultPersistenceModeByTargetKey: { 'agent:claude': 'direct' },
      compatibilityByTargetKey: { 'agent:claude': true },
      codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled' }, createdAt: 1, updatedAt: 2 });
    const record = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'legacy', profile }, enabled: false,
      promptStack: [{ id: 'private-stack-entry', ref: { kind: 'doc', artifactId: 'private-prompt' }, enabled: true, placement: 'system_append', required: true }],
      secretBindings: { DEEPSEEK_AUTH_TOKEN: 'secret-a', OTHER_TOKEN: 'private-secret' } });
    const promptStacksV1 = { v: 1, surfaces: { coding: [], voice: [], profilesById: { [id]: record.promptStack } } };
    const raw = { profiles: [profile], profileEnabledById: { [id]: record.enabled }, favoriteProfiles: [id],
      secretBindingsByProfileId: { [id]: record.secretBindings }, promptStacksV1, unrelated: { keep: true } };

    // New authoring remains bounded; representation conversion must not re-author retained data.
    const authored = { v: 2, id, name: profile.name, extraEnvironmentVariables: publicEnvironment, envVarRequirements: publicRequirements, createdAt: 1, updatedAt: 2 };
    expect(LaunchProfileV2Schema.safeParse({ ...authored, extraEnvironmentVariables: [], envVarRequirements: [] }).success).toBe(false);
    expect(LaunchProfileV2Schema.safeParse({ ...authored, id: 'new-profile' }).success).toBe(false);
    expect(LaunchProfileV2Schema.safeParse({ ...authored, id: 'new-profile', extraEnvironmentVariables: [], envVarRequirements: [] }).success).toBe(true);

    const reviewedMapping = LegacyProfileReviewedMappingV1Schema.parse({
      connection: { v: 1, id: 'pc-company', role: 'named', displayName: 'Company', displayNameMode: 'custom',
        revision: 0, createdAt: 20, updatedAt: 20, source: { kind: 'custom', template: { v: 1, name: 'Company',
          endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://company.example/v1',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
          credential: { kind: 'apiKey', slotId: 'apiKey', required: true,
            transports: [{ id: 'key', protocols: ['openai-chat'], uses: ['probe', 'runtime'],
              destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
          catalog: { source: 'manual', manualModelPolicy: 'allowed' } } } },
      credentialMoves: [{ legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey', credentialStyle: 'bearer' }],
      routingEnvironmentVariableNames: [], manualModelIds: ['company-model'],
      selectedModel: { agentTargetKey: 'agent:claude', modelId: 'company-model' },
    });
    const confirmation = { rawSettings: raw, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, sourceProfileId: id, reviewedMapping, authoringMemory: { lastUsedProfile: id },
      recordContext: { profileRecordIds: [id], records: [{ record, revision: 4 }] } };
    const result = confirmLegacyAiLaunchProfileMigrationV1({ ...confirmation, migratedAt: 20,
      expectedSourceFingerprint: createLegacyProfileMigrationSourceFingerprintV1(confirmation) });
    expect(result.ok ? true : result).toBe(true);
    if (!result.ok) throw new Error('expected accepted Provider conversion');
    expect(result.settings).toMatchObject({ profiles: [{ v: 2, id, name: profile.name, description: profile.description,
      extraEnvironmentVariables: publicEnvironment, envVarRequirements: publicRequirements,
      defaultPermissionModeByTargetKey: profile.defaultPermissionModeByTargetKey,
      defaultPersistenceModeByTargetKey: profile.defaultPersistenceModeByTargetKey,
      compatibilityByTargetKey: profile.compatibilityByTargetKey,
      codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' },
      preferredModelSelection: { ref: { providerConnectionId: 'pc-company' } }, createdAt: 1, updatedAt: 2 }],
      profileEnabledById: { [id]: false }, secretBindingsByProfileId: { [id]: { OTHER_TOKEN: 'private-secret' } },
      promptStacksV1, unrelated: { keep: true } });
    expect(result.providerSettings).toMatchObject({ connections: [{ id: 'pc-company' }] });
    expect(result.providerSettings.migration).toBeUndefined();
    expect(result).not.toHaveProperty('lastUsedProfileClear');
    const convertedProfile = Array.isArray(result.settings.profiles) ? result.settings.profiles[0] : undefined;
    const convertedRecord = ProfileRecordV1Schema.parse({ ...record, definition: { kind: 'inline', profile: convertedProfile },
      secretBindings: { OTHER_TOKEN: 'private-secret' } });
    expect(convertedRecord).toMatchObject({ id, enabled: record.enabled, promptStack: record.promptStack,
      secretBindings: { OTHER_TOKEN: 'private-secret' }, definition: { kind: 'inline', profile: { id } } });
    expect(record.definition).toEqual({ kind: 'legacy', profile });
  });

  it('preserves private record identity, enablement and remaining bindings when routing is the entire profile', () => {
    const profile = AIBackendProfileSchema.parse({ id: 'deepseek', name: 'My routing profile', isBuiltIn: true,
      environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }],
      codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled' }, createdAt: 1, updatedAt: 1 });
    const result = migrateLegacyAiLaunchProfilesV1({ profiles: [profile],
      profileEnabledById: { deepseek: true }, favoriteProfiles: ['deepseek'],
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'secret-a', OTHER_TOKEN: 'secret-private' } },
    }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, candidates: [connectionCandidate('deepseek', 'pc-deepseek')], pendingCustomProfileIds: [] },
    { lastUsedProfile: 'deepseek' }, { profileRecordIds: ['deepseek'] });
    expect(result).toMatchObject({ ok: true, settings: {
      profiles: [{ v: 2, id: 'deepseek', name: 'My routing profile', extraEnvironmentVariables: [],
        codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' },
        preferredModelSelection: { ref: { providerConnectionId: 'pc-deepseek' } } }],
      profileEnabledById: { deepseek: true }, favoriteProfiles: ['deepseek'],
      secretBindingsByProfileId: { deepseek: { OTHER_TOKEN: 'secret-private' } },
    } });
    expect(result).not.toHaveProperty('lastUsedProfileClear');
  });

  it('keeps private machine-login compatibility definitions and their attachments on Default Environment migration', () => {
    const profile = AIBackendProfileSchema.parse({ id: 'anthropic', name: 'Claude login', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: 'agent:claude', createdAt: 1, updatedAt: 1 });
    const result = migrateLegacyAiLaunchProfilesV1({ profiles: [profile], profileEnabledById: { anthropic: true },
      secretBindingsByProfileId: { anthropic: { OTHER_TOKEN: 'secret-private' } },
    }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, candidates: [{ kind: 'default_environment', sourceProfileId: 'anthropic' }], pendingCustomProfileIds: [] },
    { lastUsedProfile: 'anthropic' }, { profileRecordIds: ['anthropic'] });
    expect(result).toMatchObject({ ok: true, settings: { profiles: [profile], profileEnabledById: { anthropic: true },
      secretBindingsByProfileId: { anthropic: { OTHER_TOKEN: 'secret-private' } } } });
    expect(result).not.toHaveProperty('lastUsedProfileClear');
  });

  it('preserves a private machine-login prerequisite when its Provider connection is converted', () => {
    const profile = AIBackendProfileSchema.parse({ id: 'company', name: 'Company', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: 'agent:claude', environmentVariables: [
        { name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, { name: 'TEAM_FLAG', value: 'public' }],
      envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }], createdAt: 1, updatedAt: 1 });
    const result = migrateLegacyAiLaunchProfilesV1({ profiles: [profile], secretBindingsByProfileId: {
      company: { DEEPSEEK_AUTH_TOKEN: 'secret-a', OTHER_TOKEN: 'private-secret' } },
    }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, candidates: [connectionCandidate('company', 'pc-company')], pendingCustomProfileIds: [] },
    { lastUsedProfile: 'company' }, { profileRecordIds: ['company'] });
    expect(result).toMatchObject({ ok: true, settings: { profiles: [{ id: 'company', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: normalizeBackendTargetKeyV2Input('agent:claude'), environmentVariables: [{ name: 'TEAM_FLAG', value: 'public' }], envVarRequirements: [] }],
      secretBindingsByProfileId: { company: { OTHER_TOKEN: 'private-secret' } } } });
    expect(result.ok && result.providerSettings).toMatchObject({ connections: [{ id: 'pc-company' }] });
    expect(result).not.toHaveProperty('lastUsedProfileClear');
  });

  it('classifies descriptor credential aliases and secret requirements without treating endpoint or model literals as credentials', () => {
    const profile = AIBackendProfileSchema.parse({ id: 'custom', name: 'Custom', environmentVariables: [
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'literal-key' }, { name: 'DEEPSEEK_AUTH_TOKEN', value: 'other-key' },
      { name: 'ANTHROPIC_BASE_URL', value: 'https://example.test' }, { name: 'ANTHROPIC_MODEL', value: 'model' },
      { name: 'PRIVATE_VALUE', value: 'private', isSecret: true },
    ], envVarRequirements: [{ name: 'REQUIRED_KEY', kind: 'secret', required: true }], createdAt: 1, updatedAt: 1 });
    const names = listLegacyAiLaunchProfileCredentialEnvironmentVariableNamesV1(profile, [{ legacyProfileMigrations: [{
      sourceProfileId: 'deepseek', descriptorRevision: 1, implicitModelAliasReplacements: [],
      credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
      migratedEnvironmentVariables: [
        { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
        { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://example.test}' },
        { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-model}' },
      ], retainedEnvironmentVariables: [],
    }] }]);
    expect(new Set(names)).toEqual(new Set(['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_AUTH_TOKEN', 'PRIVATE_VALUE', 'REQUIRED_KEY']));
    const template = { ...profile, environmentVariables: [
      { name: 'PRIVATE_VALUE', value: '${BOUND_KEY}', isSecret: true },
      { name: 'REQUIRED_KEY', value: '${MISSING_KEY}' },
      { name: 'ANTHROPIC_MODEL', value: 'not-a-secret' },
    ] };
    expect(listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1(template, [], { BOUND_KEY: 'secret-a' }))
      .toEqual(['REQUIRED_KEY']);
    expect(requiresLegacyAiLaunchProfileProviderSourcePreparationV1({ environmentVariables: [
      { name: 'TEAM_FLAG', value: 'public' }, { name: 'PRIVATE_VALUE', value: '${BOUND_KEY}', isSecret: true },
    ], envVarRequirements: [] }, { BOUND_KEY: 'secret-a' })).toBe(false);
    expect(requiresLegacyAiLaunchProfileProviderSourcePreparationV1({ environmentVariables: [
      { name: 'DEEPSEEK_AUTH_TOKEN', value: 'literal' },
    ], envVarRequirements: [] }, {})).toBe(true);
    expect(requiresLegacyAiLaunchProfileProviderSourcePreparationV1({ environmentVariables: [
      { name: 'PRIVATE_VALUE', value: 'literal', isSecret: true },
    ], envVarRequirements: [] }, {})).toBe(true);
  });

  it('returns a conditional authoring-memory clear when removing a Profile, without writing a Settings root, and repairs an interrupted clear', () => {
    const raw = {
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }], createdAt: 1, updatedAt: 1 }],
    };
    const context = { migratedAt: 20, candidates: [connectionCandidate('deepseek', 'pc-deepseek')], pendingCustomProfileIds: [] };
    const memory = { lastUsedProfile: 'deepseek' };
    const result = migrateLegacyAiLaunchProfilesV1(raw, DEFAULT_PROVIDER_SETTINGS_V1, context, memory);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration');
    expect(result.settings).not.toHaveProperty('lastUsedProfile');
    expect(result.lastUsedProfileClear).toEqual({ base: 'deepseek', proposed: null });
    const repeated = migrateLegacyAiLaunchProfilesV1(result.settings, result.providerSettings, { ...context, candidates: [] }, memory);
    expect(repeated).toMatchObject({ ok: true, changed: false, lastUsedProfileClear: { base: 'deepseek', proposed: null } });
  });

  it('atomically migrates provider state, bindings, favorites and last-used without mutating unrelated fields', () => {
    const raw = {
      schemaVersion: 7,
      unknown: { preserve: true },
      savedSecrets: [{ id: 'secret-a', opaque: true }],
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [{ name: 'API_TIMEOUT_MS', value: '600000' }], createdAt: 1, updatedAt: 1 }],
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'secret-a' } },
      lastUsedProfile: 'deepseek',
      favoriteProfiles: ['deepseek'],
      profileEnabledById: { deepseek: true },
    };
    const result = migrateLegacyAiLaunchProfilesV1(raw, DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [connectionCandidate('deepseek', 'pc-deepseek')],
      pendingCustomProfileIds: [],
    }, { lastUsedProfile: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration');
    expect(result.settings).toMatchObject({
      schemaVersion: 7,
      unknown: { preserve: true },
      savedSecrets: [{ id: 'secret-a', opaque: true }],
      lastUsedProfile: 'deepseek',
      favoriteProfiles: [],
    });
    expect(result.providerSettings).toMatchObject({ connections: [{ id: 'pc-deepseek' }],
      secretBindingsByConnectionId: { 'pc-deepseek': { account: { apiKey: 'secret-a' } } } });
    const settings = result.settings as Record<string, unknown>;
    expect((settings.profiles as Array<Record<string, unknown>>)[0]).toMatchObject({ v: 2, id: 'deepseek' });
    expect(settings.secretBindingsByProfileId).toEqual({});
    expect(settings.favoriteModelSelectionsV1).toEqual([{
      selection: {
        v: 1,
        ref: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc-deepseek', modelId: 'deepseek-reasoner' },
        updatedAt: 20,
      },
      addedAtMs: 20,
    }]);
    expect(result.providerSettings.defaultsByAgentTargetKey).toEqual({});
  });

  it('records explicit disabled intent terminally and leaves no-evidence sources untouched', () => {
    const disabled = migrateLegacyAiLaunchProfilesV1({
      schemaVersion: 6,
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
      profileEnabledById: { deepseek: false },
      favoriteProfiles: ['deepseek'],
    }, DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{ kind: 'skipped_disabled', sourceProfileId: 'deepseek' }],
      pendingCustomProfileIds: [],
    }, { lastUsedProfile: null });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) throw new Error('expected disabled migration');
    expect(disabled.providerSettings.migration?.completedSources).toContainEqual({
      sourceProfileId: 'deepseek', kind: 'skipped_disabled',
    });
    expect(disabled.providerSettings.connections).toEqual([]);
    expect((disabled.settings.profiles as any[])[0].id).toBe('deepseek');
    expect(disabled.settings.favoriteProfiles).toEqual(['deepseek']);

    const noEvidence = migrateLegacyAiLaunchProfilesV1({
      schemaVersion: 7,
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
    }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, candidates: [], pendingCustomProfileIds: [] }, { lastUsedProfile: null });
    expect(noEvidence.ok).toBe(true);
    if (!noEvidence.ok) throw new Error('expected no-op migration');
    expect(noEvidence.changed).toBe(false);
    expect(noEvidence.settings).toEqual({
      schemaVersion: 7,
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
    });
  });

  it('refuses conflicting credentials independently of candidate order', () => {
    for (const candidates of [
      [connectionCandidate('deepseek-a', 'pc-a', 'secret-a'), connectionCandidate('deepseek-b', 'pc-b', 'secret-b')],
      [connectionCandidate('deepseek-b', 'pc-b', 'secret-b'), connectionCandidate('deepseek-a', 'pc-a', 'secret-a')],
    ]) {
      const result = migrateLegacyAiLaunchProfilesV1({ schemaVersion: 7 }, DEFAULT_PROVIDER_SETTINGS_V1, {
        migratedAt: 20,
        candidates,
        pendingCustomProfileIds: [],
      }, { lastUsedProfile: null });
      expect(result).toMatchObject({ ok: false, changed: false, reason: 'migration_conflict' });
    }
  });

  it('preserves retained Azure, Gemini, opaque profiles and unrelated profile domains byte-for-byte', () => {
    const profiles = [
      { id: 'azure-openai', opaque: { keep: true } },
      { id: 'gemini-api-key', opaque: { keep: true } },
      { v: 99, id: 'future', opaque: { keep: true } },
    ];
    const raw = {
      schemaVersion: 7,
      profiles,
      browserProfileId: 'browser-profile',
      connectedServiceProfileId: 'service-profile',
      secretBindingsByProfileId: { 'azure-openai': { AZURE_OPENAI_API_KEY: 'azure-secret' } },
    };
    const result = migrateLegacyAiLaunchProfilesV1(raw, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20, candidates: [], pendingCustomProfileIds: [] }, { lastUsedProfile: null });
    expect(result).toEqual({ ok: true, changed: false, settings: raw, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, outcomes: [] });
  });

  it('binds guided custom confirmation to the exact profile, secret binding, evidence, and reviewed mapping', () => {
    const raw = {
      schemaVersion: 7,
      profiles: [{
        id: 'company', name: 'Company',
        environmentVariables: [
          { name: 'OPENAI_BASE_URL', value: 'https://company.example/v1' },
          { name: 'RETAINED_TOKEN', value: '${RETAINED_TOKEN}' },
        ],
        envVarRequirements: [
          { name: 'COMPANY_API_KEY', kind: 'secret', required: true },
          { name: 'RETAINED_TOKEN', kind: 'secret', required: true },
        ],
        createdAt: 1, updatedAt: 1,
      }],
      secretBindingsByProfileId: { company: { COMPANY_API_KEY: 'secret-a', RETAINED_TOKEN: 'secret-retained' } },
      lastUsedProfile: 'company',
    };
    const reviewedMapping = {
      connection: {
        v: 1 as const,
        id: 'pc-company',
        source: {
          kind: 'custom' as const,
          template: {
            v: 1 as const,
            name: 'Company',
            endpointTemplates: [{
              id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://company.example/v1',
              capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const, statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const },
            }],
            credential: {
              kind: 'apiKey' as const, slotId: 'apiKey' as const, required: true,
              transports: [{ id: 'key', protocols: ['openai-chat' as const], uses: ['probe' as const, 'runtime' as const], destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const } }],
            },
            catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
          },
        },
        role: 'named' as const,
        displayName: 'Company', displayNameMode: 'custom' as const,
        revision: 0, createdAt: 20, updatedAt: 20,
      },
      credentialMoves: [{ legacyEnvVarName: 'COMPANY_API_KEY', credentialSlotId: 'apiKey', credentialStyle: 'bearer' as const }],
      routingEnvironmentVariableNames: ['OPENAI_BASE_URL'],
      manualModelIds: ['company-model'],
      selectedModel: { agentTargetKey: 'agent:codex', modelId: 'company-model' },
    };
    const fingerprint = createLegacyProfileMigrationSourceFingerprintV1({
      rawSettings: raw, sourceProfileId: 'company', reviewedMapping, authoringMemory: { lastUsedProfile: 'company' },
    });
    const privateRecord = ProfileRecordV1Schema.parse({ v: 1, id: 'company', enabled: true,
      definition: { kind: 'legacy', profile: raw.profiles[0] }, promptStack: [],
      secretBindings: raw.secretBindingsByProfileId.company });
    const recordAwareInput = { rawSettings: raw, sourceProfileId: 'company', reviewedMapping,
      authoringMemory: { lastUsedProfile: 'company' },
      recordContext: { profileRecordIds: ['company'], records: [{ record: privateRecord, revision: 2 }] } };
    const privateFingerprint = createLegacyProfileMigrationSourceFingerprintV1(recordAwareInput);
    expect(createLegacyProfileMigrationSourceFingerprintV1({ ...recordAwareInput,
      recordContext: { ...recordAwareInput.recordContext, records: [{ record: { ...privateRecord,
        secretBindings: { ...privateRecord.secretBindings, RETAINED_TOKEN: 'secret-other' } }, revision: 3 }] },
    })).not.toBe(privateFingerprint);
    expect(createLegacyProfileMigrationSourceFingerprintV1({
      rawSettings: { ...raw, lastUsedProfile: 'retired-raw-value' }, sourceProfileId: 'company', reviewedMapping,
      authoringMemory: { lastUsedProfile: 'company' },
    })).toBe(fingerprint);
    expect(createLegacyProfileMigrationSourceFingerprintV1({
      rawSettings: raw, sourceProfileId: 'company', reviewedMapping, authoringMemory: { lastUsedProfile: null },
    })).not.toBe(fingerprint);
    const mismatchedCredentialStyle = structuredClone(reviewedMapping);
    mismatchedCredentialStyle.credentialMoves[0]!.credentialStyle = 'x-api-key' as const;
    expect(LegacyProfileReviewedMappingV1Schema.safeParse(mismatchedCredentialStyle).success).toBe(false);
    const changedBinding = structuredClone(raw);
    changedBinding.secretBindingsByProfileId.company.COMPANY_API_KEY = 'secret-b';
    expect(confirmLegacyAiLaunchProfileMigrationV1({ providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, authoringMemory: { lastUsedProfile: 'company' },
      rawSettings: changedBinding,
      sourceProfileId: 'company', expectedSourceFingerprint: fingerprint, reviewedMapping, migratedAt: 20,
    })).toMatchObject({ ok: false, changed: false, reason: 'legacy_profile_source_changed' });

    const malformedBinding = structuredClone(raw);
    malformedBinding.secretBindingsByProfileId.company.COMPANY_API_KEY = ' secret-a ';
    const malformedFingerprint = createLegacyProfileMigrationSourceFingerprintV1({ authoringMemory: { lastUsedProfile: null },
      rawSettings: malformedBinding, sourceProfileId: 'company', reviewedMapping,
    });
    expect(confirmLegacyAiLaunchProfileMigrationV1({ providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, authoringMemory: { lastUsedProfile: null },
      rawSettings: malformedBinding,
      sourceProfileId: 'company', expectedSourceFingerprint: malformedFingerprint, reviewedMapping, migratedAt: 20,
    })).toMatchObject({ ok: false, changed: false, reason: 'legacy_profile_source_changed' });

    const confirmed = confirmLegacyAiLaunchProfileMigrationV1({ providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, authoringMemory: { lastUsedProfile: 'company' },
      rawSettings: raw,
      sourceProfileId: 'company', expectedSourceFingerprint: fingerprint, reviewedMapping, migratedAt: 20,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('expected confirmed migration');
    expect(confirmed.settings).toMatchObject({
      profiles: [{
        v: 2,
        id: 'company',
        extraEnvironmentVariables: [{ name: 'RETAINED_TOKEN', value: '${RETAINED_TOKEN}' }],
        envVarRequirements: [{ name: 'RETAINED_TOKEN', kind: 'secret', required: true }],
      }],
      secretBindingsByProfileId: { company: { RETAINED_TOKEN: 'secret-retained' } },
    });
    expect(confirmed.providerSettings).toMatchObject({ connections: [{ id: 'pc-company' }],
      secretBindingsByConnectionId: { 'pc-company': { account: { apiKey: 'secret-a' } } },
      manualModelsByConnectionId: { 'pc-company': [{ id: 'company-model' }] } });
  });

  it('preserves every auxiliary environment row for deterministic built-ins while removing routing/auth/primary-model ownership', () => {
    const cases = [
      {
        id: 'deepseek', agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner',
        migrated: [
          { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
          { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-reasoner}' },
        ],
        retained: [
          { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
          { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-chat}' },
          { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
        ],
      },
      {
        id: 'zai', agentTargetKey: 'agent:claude', modelId: 'GLM-4.6',
        migrated: [
          { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}' },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
          { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' },
        ],
        retained: [
          { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS:-3000000}' },
          { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL:-GLM-4.6}' },
          { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL:-GLM-4.6}' },
          { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}' },
        ],
      },
      {
        id: 'openai', agentTargetKey: 'agent:codex', modelId: 'gpt-5-codex-high',
        migrated: [
          { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
          { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
        ],
        retained: [
          { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
          { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
          { name: 'API_TIMEOUT_MS', value: '600000' },
          { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
        ],
      },
    ] as const;
    for (const fixture of cases) {
      // This protocol owner deliberately receives the migration payload rather than
      // importing plugin definitions. Plugin contribution tests pin the exact
      // descriptors; this test pins lossless profile slimming at the boundary.
      const profile = AIBackendProfileSchema.parse({
        id: fixture.id,
        name: fixture.id,
        isBuiltIn: true,
        environmentVariables: [...fixture.migrated, ...fixture.retained],
        createdAt: 1,
        updatedAt: 1,
      });
      const base = connectionCandidate(fixture.id, `pc-${fixture.id}`);
      const result = migrateLegacyAiLaunchProfilesV1({
        schemaVersion: 7, profiles: [profile], lastUsedProfile: fixture.id,
      }, DEFAULT_PROVIDER_SETTINGS_V1, {
        migratedAt: 20,
        candidates: [{
          ...base,
          sourceProfileId: fixture.id,
          connection: {
            ...base.connection,
            id: `pc-${fixture.id}`,
            source: { kind: 'contribution', contributionKey: `happier.provider.${fixture.id}/${fixture.id}` },
          },
          selectedModel: { agentTargetKey: fixture.agentTargetKey, modelId: fixture.modelId },
          manualModels: [{ id: fixture.modelId, addedAt: 20 }],
        }],
        pendingCustomProfileIds: [],
      }, { lastUsedProfile: null });
      expect(result.ok, fixture.id).toBe(true);
      if (!result.ok) continue;
      const slim = (result.settings.profiles as any[])[0];
      expect(slim.v).toBe(2);
      expect(slim.extraEnvironmentVariables).toEqual(fixture.retained);
      for (const migrated of fixture.migrated) {
        expect(slim.extraEnvironmentVariables).not.toContainEqual(migrated);
      }
    }
  });

  it('preserves unrelated poison-named legacy binding and enablement records through another source migration', () => {
    const secretBindingsByProfileId = JSON.parse('{"__proto__":{"TOKEN":"secret-id"}}') as Record<string, unknown>;
    const profileEnabledById = JSON.parse('{"__proto__":true}') as Record<string, unknown>;
    const result = migrateLegacyAiLaunchProfilesV1({
      profiles: [{ id: '__proto__', name: 'Opaque-safe', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
      secretBindingsByProfileId,
      profileEnabledById,
      lastUsedProfile: 'anthropic',
    }, DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{ kind: 'default_environment', sourceProfileId: 'anthropic' }],
      pendingCustomProfileIds: [],
    }, { lastUsedProfile: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration');
    expect(Object.prototype.hasOwnProperty.call(result.settings.secretBindingsByProfileId, '__proto__')).toBe(true);
    expect((result.settings.secretBindingsByProfileId as Record<string, unknown>)['__proto__'])
      .toEqual({ TOKEN: 'secret-id' });
    expect(Object.prototype.hasOwnProperty.call(result.settings.profileEnabledById, '__proto__')).toBe(true);
    expect((result.settings.profileEnabledById as Record<string, unknown>)['__proto__']).toBe(true);
  });
});
