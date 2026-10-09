import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from './backendProfileSchema.js';
import { LaunchProfileV2Schema } from './v2/schema.js';
import { normalizeBackendTargetKeyV2Input } from '../backends/targets/backendTargetRefV2.js';

import {
  isLaunchProfileV2,
  readAiLaunchProfileCollection,
  loadAiLaunchProfileArtifacts,
  readAiLaunchProfileRecords,
  AiLaunchProfileV1Schema,
  prepareLegacyProfileRecordsV1,
  removeTransferredProfileSourcesV1,
  hasProfileTransferSourceV1,
  readLegacyProfileRecordsV1,
  resolveProfileCatalogAuthorityV1,
  readAiLaunchProfileEnabledV1,
  removeProfilePreferenceReferencesV1,
  shouldPreserveLegacyAiLaunchProfileBindingV1,
} from './read.js';

describe('readAiLaunchProfileCollection', () => {
  it('admits the canonical enriched opened projection and refuses unknown public fields or invalid source revisions', () => {
    const result = readAiLaunchProfileRecords([{ v: 1, id: 'legacy', enabled: false,
      definition: { kind: 'legacy', profile: { id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 1,
        codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' } } },
      promptStack: [{ id: 'private-stack', enabled: true, ref: { kind: 'bundle', artifactId: 'bundle' },
        placement: 'skill_instructions', editPolicy: 'user_only' }], secretBindings: { TOKEN: 'legacy-secret' } },
    { v: 1, id: 'inline', enabled: true, definition: { kind: 'inline', profile: {
      v: 2, id: 'inline', name: 'Inline', createdAt: 1, updatedAt: 1,
    } }, promptStack: [], secretBindings: {} }], { recordRevisionsById: new Map([['legacy', 7], ['inline', 8]]) });
    const profiles = result.entries.flatMap((entry) => entry.kind === 'opaque' ? [] : [entry.profile]);
    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      expect(AiLaunchProfileV1Schema.safeParse(profile).success).toBe(true);
      expect(AiLaunchProfileV1Schema.safeParse({ ...profile, unknownPublicField: 'must-refuse' }).success).toBe(false);
      expect(AiLaunchProfileV1Schema.safeParse({ ...profile, profileRecordRevision: -1 }).success).toBe(false);
      expect(AiLaunchProfileV1Schema.safeParse({ ...profile, revision: { headerVersion: 1, bodyVersion: -1 } }).success).toBe(false);
      expect(AiLaunchProfileV1Schema.safeParse({ ...profile,
        codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled', unknownOverrideField: 'must-refuse' } }).success).toBe(false);
    }
  });

  it('selects native destination rows without a fabricated transfer marker and keeps prepared sources authoritative', () => {
    expect(resolveProfileCatalogAuthorityV1({ rawSettings: {}, control: null })).toBe('destination');
    const source = { profiles: [{ id: 'source', name: 'Source' }] };
    expect(resolveProfileCatalogAuthorityV1({ rawSettings: source, control: null })).toBe('legacy');
    const prepared = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 7, migratedLogicalRevision: 1, inventory: [] };
    expect(resolveProfileCatalogAuthorityV1({ rawSettings: source, control: prepared })).toBe('legacy');
    expect(resolveProfileCatalogAuthorityV1({ rawSettings: {}, control: prepared })).toBe('legacy');
    expect(resolveProfileCatalogAuthorityV1({ rawSettings: { profiles: 'stale-corrupt-source' },
      control: { ...prepared, phase: 'active' } })).toBe('destination');
  });

  it('distinguishes fresh source absence from explicit empty, malformed and scoped legacy roots', () => {
    expect(hasProfileTransferSourceV1({})).toBe(false);
    expect(hasProfileTransferSourceV1({ unrelated: 'keep', promptStacksV1: { v: 1, surfaces: { global: [] } } })).toBe(false);
    expect(hasProfileTransferSourceV1({ profileEnabledById: { anthropic: false, codex: true } })).toBe(false);
    expect(hasProfileTransferSourceV1({ profileEnabledById: {} })).toBe(false);
    for (const raw of [{ profiles: [] }, { profiles: 'invalid' }, { secretBindingsByProfileId: {} },
      { profileEnabledById: { unknown: false } }, { profileEnabledById: { anthropic: 'invalid' } },
      { promptStacksV1: { v: 1, surfaces: { profilesById: {} } } },
      { promptStacksV1: { v: 99 } }, null]) expect(hasProfileTransferSourceV1(raw)).toBe(true);
  });

  it('reads the inactive source for repair without presenting ineligible imports as destination authority', () => {
    const raw = { profiles: [{ id: 'private-source', name: 'Private source',
      environmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'retained-value', isSecret: true }], createdAt: 1, updatedAt: 1 }],
      profileEnabledById: { 'private-source': false }, secretBindingsByProfileId: { 'private-source': { OTHER_TOKEN: 'source-secret' } } };
    expect(readLegacyProfileRecordsV1(raw).records).toEqual([expect.objectContaining({ id: 'private-source', enabled: false,
      secretBindings: { OTHER_TOKEN: 'source-secret' }, definition: { kind: 'legacy', profile: expect.objectContaining({
        environmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'retained-value', isSecret: true }],
      }) } })]);
    expect(prepareLegacyProfileRecordsV1(raw).status).toBe('partial');
  });

  it('cleans only transferred Profile sources after activation and keeps other prompt surfaces and selected-ID preferences', () => {
    const source = { profiles: [{ id: 'work', name: 'Work' }], secretBindingsByProfileId: { work: { TOKEN: 'secret' } },
      profileEnabledById: { work: false, anthropic: false, 'azure-openai': false }, favoriteProfiles: ['work', 'other'],
      promptStacksV1: { v: 1, future: 'retain', surfaces: { profilesById: { work: [] }, global: ['retain'], botsById: { bot: [] } } },
      unknownRoot: { retain: true } };
    expect(removeTransferredProfileSourcesV1(source, ['work', 'anthropic'])).toEqual({
      profileEnabledById: { 'azure-openai': false }, favoriteProfiles: ['work', 'other'],
      promptStacksV1: { v: 1, future: 'retain', surfaces: { global: ['retain'], botsById: { bot: [] } } },
      unknownRoot: { retain: true },
    });
    expect(source.profiles).toEqual([{ id: 'work', name: 'Work' }]);
  });

  it('uses builtin membership entity enablement and only reads preferences without an entity', () => {
    const result = readAiLaunchProfileRecords([
      { v: 1, id: 'anthropic', enabled: false, definition: { kind: 'legacy', profile: {
        id: 'anthropic', name: 'Builtin', isBuiltIn: true, createdAt: 1, updatedAt: 1 } }, promptStack: [], secretBindings: { TOKEN: 'secret-a' } },
      { v: 1, id: 'custom', enabled: false, definition: { kind: 'inline', profile: {
        v: 2, id: 'custom', name: 'Custom', createdAt: 1, updatedAt: 1 } }, promptStack: [], secretBindings: {} },
    ]);
    const profiles = result.entries.flatMap((entry) => entry.kind === 'opaque' ? [] : [entry.profile]);
    expect(profiles.map((profile) => readAiLaunchProfileEnabledV1(profile, { anthropic: true, custom: true }))).toEqual([false, false]);
    expect(profiles.map((profile) => readAiLaunchProfileEnabledV1(profile, {}))).toEqual([false, false]);
    const noEntity = AIBackendProfileSchema.parse({ id: 'azure-openai', name: 'No entity builtin', isBuiltIn: true,
      defaultEnabled: true, createdAt: 1, updatedAt: 1 });
    expect(readAiLaunchProfileEnabledV1(noEntity, { 'azure-openai': false })).toBe(false);
    expect(readAiLaunchProfileEnabledV1(noEntity, {})).toBe(true);
  });

  it('uses entity enablement after a historical builtin identity becomes a canonical inline Provider conversion', () => {
    // migrateLegacyAiLaunchProfilesV1/commitActiveMigrationSource retain the identity
    // and private metadata, while the reviewed connection outcome becomes inline V2.
    const result = readAiLaunchProfileRecords([{ v: 1, id: 'deepseek', enabled: false,
      definition: { kind: 'inline', profile: { v: 2, id: 'deepseek', name: 'Converted DeepSeek', createdAt: 1, updatedAt: 1 } },
      promptStack: [], secretBindings: {} }]);
    const profile = result.entries[0];
    expect(profile?.kind).toBe('slim');
    if (!profile || profile.kind === 'opaque') throw new Error('Expected admitted inline conversion');
    expect(readAiLaunchProfileEnabledV1(profile.profile, { deepseek: true })).toBe(false);
    expect(readAiLaunchProfileEnabledV1(profile.profile, {})).toBe(false);
  });

  it('keeps Artifact membership enablement on its row despite a legacy builtin flag in the granted body', () => {
    const artifact = { artifactId: 'preset-copy', access: 'edit' as const, revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'launch-profile.v1', profileId: 'gemini-api-key', name: 'Published preset' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
        id: 'gemini-api-key', name: 'Published preset', isBuiltIn: true, createdAt: 1, updatedAt: 1,
      } }) };
    const result = readAiLaunchProfileRecords([{ v: 1, id: 'gemini-api-key', enabled: false,
      definition: { kind: 'artifact', artifactId: artifact.artifactId }, promptStack: [], secretBindings: {} }],
    { artifactsById: new Map([[artifact.artifactId, artifact]]) });
    const entry = result.entries[0];
    expect(entry?.kind).toBe('legacy');
    if (!entry || entry.kind === 'opaque') throw new Error('Expected admitted Artifact body');
    expect(entry.profile.artifactId).toBe(artifact.artifactId);
    expect(readAiLaunchProfileEnabledV1(entry.profile, { 'gemini-api-key': true })).toBe(false);
  });

  it('suppresses an inherited Artifact binding with an explicit private none override without hiding neighboring bindings', () => {
    const artifact = { artifactId: 'shared-profile', access: 'edit' as const,
      revision: { headerVersion: 2, bodyVersion: 3 },
      header: { kind: 'launch-profile.v1', profileId: 'work', name: 'Work' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
        v: 2, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1,
      }, secretBindings: { TOKEN: 'shared-token', KEEP: 'shared-neighbor' } }) };
    const privateRecord = { v: 1, id: 'work', enabled: true,
      definition: { kind: 'artifact', artifactId: artifact.artifactId }, promptStack: [],
      secretBindings: { TOKEN: null, PRIVATE: 'private-neighbor' } };
    const result = readAiLaunchProfileRecords([privateRecord], { artifactsById: new Map([[artifact.artifactId, artifact]]) });
    expect(result.diagnostics).toEqual([]);
    const entry = result.entries[0];
    expect(entry?.kind).toBe('slim');
    if (!entry || entry.kind === 'opaque') throw new Error('Expected admitted private override');
    expect(entry.profile.secretBindings).toEqual({ KEEP: 'shared-neighbor', PRIVATE: 'private-neighbor' });
    expect(privateRecord.secretBindings.TOKEN).toBeNull();
    expect(JSON.parse(artifact.body).secretBindings.TOKEN).toBe('shared-token');
  });

  it('does not reinterpret malformed predecessor binding nulls as a private entity none override', () => {
    const raw = { profiles: [{ id: 'work', name: 'Work', createdAt: 1, updatedAt: 1 }],
      secretBindingsByProfileId: { work: { TOKEN: null } } };
    const result = prepareLegacyProfileRecordsV1(raw);
    expect(result.status).toBe('partial');
    expect(result.diagnostics).toContainEqual({ profileId: 'work', reason: 'malformed' });
    expect(result.records).toEqual([]);
    expect(raw.secretBindingsByProfileId.work.TOKEN).toBeNull();
  });

  it('removes addressed entity enablement and favorites without altering no-entity builtin preferences', () => {
    const raw = { favoriteProfiles: ['gemini-api-key', 'anthropic', 'custom'],
      profileEnabledById: { 'gemini-api-key': false, anthropic: false, custom: true }, unknown: 'retain' };
    const builtin = (id: string) => ({ kind: 'legacy' as const, profile: AIBackendProfileSchema.parse({
      id, name: 'Builtin', isBuiltIn: true, createdAt: 1, updatedAt: 1,
    }) });
    expect(removeProfilePreferenceReferencesV1(raw, 'gemini-api-key', builtin('gemini-api-key'))).toEqual({ favoriteProfiles: ['anthropic', 'custom'],
      profileEnabledById: { anthropic: false, custom: true }, unknown: 'retain' });
    expect(removeProfilePreferenceReferencesV1(raw, 'anthropic', builtin('anthropic'))).toEqual({ favoriteProfiles: ['gemini-api-key', 'custom'],
      profileEnabledById: { 'gemini-api-key': false, custom: true }, unknown: 'retain' });
    expect(removeProfilePreferenceReferencesV1(raw, 'custom', { kind: 'inline', profile: LaunchProfileV2Schema.parse({
      v: 2, id: 'custom', name: 'Custom', createdAt: 1, updatedAt: 1,
    }) })).toEqual({ favoriteProfiles: ['gemini-api-key', 'anthropic'],
      profileEnabledById: { 'gemini-api-key': false, anthropic: false }, unknown: 'retain' });
    expect(removeProfilePreferenceReferencesV1(raw, 'gemini-api-key', { kind: 'inline', profile: LaunchProfileV2Schema.parse({
      v: 2, id: 'gemini-api-key', name: 'Converted entity', createdAt: 1, updatedAt: 1,
    }) })).toEqual({ favoriteProfiles: ['anthropic', 'custom'],
      profileEnabledById: { anthropic: false, custom: true }, unknown: 'retain' });
  });

  it('loads Artifact definitions from private records without a consumer-owned reference parser', async () => {
    const artifact = { artifactId: 'record-artifact', header: { kind: 'launch-profile.v1' }, body: '{}' };
    const opened = await loadAiLaunchProfileArtifacts([{ v: 1, id: 'record', enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'artifact', artifactId: 'record-artifact' } }], {
      read: async (id) => id === artifact.artifactId ? artifact : null,
    });
    expect(opened.get('record-artifact')).toEqual(artifact);
  });

  it('imports the unbounded predecessor population and binding-only built-ins without losing entity attachments', () => {
    // Observed 0.2 writer/schema, HEAD 37a6541578749067b49d4579be8c752c9591b8c8:
    // packages/protocol/src/profiles/backendProfileSchema.ts; registry profile array is unbounded.
    const profiles = Array.from({ length: 257 }, (_, index) => ({ id: `predecessor-${index}`, name: `Profile ${index}`,
      environmentVariables: [{ name: 'TEAM_FLAG', value: '1', isSecret: false }], envVarRequirements: [],
      defaultPermissionModeByTargetKey: {}, defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {},
      defaultPersistenceModeByAgent: {}, compatibilityByTargetKey: {}, compatibility: {}, isBuiltIn: false,
      defaultEnabled: true, createdAt: 1, updatedAt: 1, version: '1.0.0' }));
    const raw = { profiles, secretBindingsByProfileId: { 'predecessor-256': { TOKEN: 'last-secret' },
      'gemini-api-key': { GEMINI_API_KEY: 'builtin-secret' } }, profileEnabledById: { 'predecessor-256': false },
      promptStacksV1: { v: 1, surfaces: { profilesById: { 'predecessor-256': [{ id: 'stack-last',
        ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' }] } } } };
    const prepared = prepareLegacyProfileRecordsV1(raw);
    expect(prepared.status).toBe('complete');
    expect(prepared.records).toHaveLength(258);
    expect(prepared.records.find((record) => record.id === 'predecessor-256')).toMatchObject({ enabled: false,
      secretBindings: { TOKEN: 'last-secret' }, promptStack: [{ id: 'stack-last', placement: 'skill_instructions' }] });
    expect(prepared.records.find((record) => record.id === 'gemini-api-key')).toMatchObject({
      definition: { kind: 'legacy', profile: { id: 'gemini-api-key' } }, secretBindings: { GEMINI_API_KEY: 'builtin-secret' } });
    expect(raw.profiles).toHaveLength(257);
  });

  it('imports actual retired predecessor builtin binding and stack identities without advertising them as current presets', () => {
    // Exact moving 0.2 preset producers at HEAD 37a6541578749067b49d4579be8c752c9591b8c8:
    // providers/{claude,codex,gemini}/builtInBackendProfiles.ts, inspected clean.
    const raw = { secretBindingsByProfileId: {
      anthropic: { PRIVATE_TOKEN: 'anthropic-secret' }, codex: { PRIVATE_TOKEN: 'codex-secret' },
      gemini: { PRIVATE_TOKEN: 'gemini-secret' }, minimax: { MINIMAX_AUTH_TOKEN: 'minimax-secret' },
      'minimax-cn': { MINIMAX_CN_AUTH_TOKEN: 'minimax-cn-secret' },
    }, profileEnabledById: { anthropic: false, minimax: false },
      promptStacksV1: { v: 1, surfaces: { profilesById: { anthropic: [{ id: 'private-stack', enabled: true,
        ref: { kind: 'bundle', artifactId: 'private-bundle' }, placement: 'skill_instructions', editPolicy: 'user_only' }] } } } };
    const options = { artifactsById: new Map(), providerContributions: [{ legacyProfileMigrations: ['minimax', 'minimax-cn'].map((id) => {
      const name = id === 'minimax' ? 'MINIMAX_AUTH_TOKEN' : 'MINIMAX_CN_AUTH_TOKEN';
      return { sourceProfileId: id, descriptorRevision: 1, implicitModelAliasReplacements: [],
        credentialBinding: { legacyEnvVarName: name, credentialSlotId: 'apiKey' },
        migratedEnvironmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${' + name + '}' }], retainedEnvironmentVariables: [] };
    }) }] };
    const result = prepareLegacyProfileRecordsV1(raw, options);
    expect(result.status).toBe('complete');
    expect(result.records).toHaveLength(5);
    expect(result.records.find((record) => record.id === 'anthropic')).toMatchObject({ definition: { kind: 'legacy', profile: {
      id: 'anthropic', name: 'Anthropic (Default)', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: normalizeBackendTargetKeyV2Input('agent:claude'),
    } }, enabled: false, secretBindings: { PRIVATE_TOKEN: 'anthropic-secret' }, promptStack: [{ id: 'private-stack' }] });
    expect(result.records.find((record) => record.id === 'minimax')).toMatchObject({ definition: { kind: 'legacy', profile: {
      id: 'minimax', name: 'MiniMax (M3)', environmentVariables: expect.arrayContaining([
        { name: 'ANTHROPIC_BASE_URL', value: '${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: '${MINIMAX_AUTH_TOKEN}' }]),
    } }, enabled: false, secretBindings: { MINIMAX_AUTH_TOKEN: 'minimax-secret' } });
    expect(hasProfileTransferSourceV1({ profileEnabledById: { minimax: false, 'minimax-cn': true } })).toBe(false);
  });

  it('does not invent a literal credential source for an implicit historical builtin private attachment', () => {
    const result = prepareLegacyProfileRecordsV1({ secretBindingsByProfileId: {
      deepseek: { OTHER_TOKEN: 'other-secret' },
    } }, { artifactsById: new Map(), providerContributions: [{ legacyProfileMigrations: [{
      sourceProfileId: 'deepseek', descriptorRevision: 1, implicitModelAliasReplacements: [],
      credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
      migratedEnvironmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }],
      retainedEnvironmentVariables: [],
    }] }] });
    expect(result.status).toBe('complete');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 'deepseek', definition: { kind: 'legacy', profile: {
      environmentVariables: expect.arrayContaining([{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }]),
    } }, secretBindings: { OTHER_TOKEN: 'other-secret' } });
  });

  it('keeps usable neighbors but prevents source removal for unavailable documents, future rows and unknown bindings', () => {
    const raw = { profiles: [{ v: 2, id: 'good', name: 'Good', createdAt: 1, updatedAt: 1 },
      { artifactId: 'locked' }, { v: 99, id: 'future', payload: 'keep' }],
      secretBindingsByProfileId: { 'unknown-source': { TOKEN: 'keep-secret' } } };
    const prepared = prepareLegacyProfileRecordsV1(raw);
    expect(prepared.status).toBe('partial');
    expect(prepared.records.map((record) => record.id)).toEqual(['good']);
    expect(prepared.diagnostics.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      'artifact_unavailable', 'future_version', 'unresolved_binding_profile',
    ]));
    expect(prepareLegacyProfileRecordsV1({ profiles: 'retained-corrupt' }).status).toBe('partial');
    const unknownEnabled = prepareLegacyProfileRecordsV1({ profileEnabledById: { 'unknown-source': false } });
    expect(unknownEnabled.status).toBe('partial');
    expect(unknownEnabled.diagnostics).toContainEqual({ profileId: 'unknown-source', reason: 'unresolved_enabled_profile' });
    expect(prepareLegacyProfileRecordsV1({ profileEnabledById: { anthropic: false } }).status).toBe('complete');
    expect(raw.secretBindingsByProfileId).toEqual({ 'unknown-source': { TOKEN: 'keep-secret' } });
  });

  it('requires promotion before importing explicitly classified inline credential literals', () => {
    const prepared = prepareLegacyProfileRecordsV1({ profiles: [{ id: 'credentials', name: 'Credentials',
      environmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private-inline-literal', isSecret: true }],
      createdAt: 1, updatedAt: 1 }] });
    expect(prepared.status).toBe('partial');
    expect(prepared.records).toEqual([]);
    expect(prepared.diagnostics).toEqual(expect.arrayContaining([
      { profileId: 'credentials', reason: 'inline-secret-requires-promotion' },
    ]));
    expect(prepareLegacyProfileRecordsV1({ profiles: [{ id: 'public', name: 'Public',
      environmentVariables: [{ name: 'TEAM_FLAG', value: 'public-literal', isSecret: false }],
      createdAt: 1, updatedAt: 1 }] }).status).toBe('complete');
  });

  it('admits only promoted exact bindings for requirement and accepted Provider credential classifications', () => {
    const options = { artifactsById: new Map(), providerContributions: [{ legacyProfileMigrations: [{
      sourceProfileId: 'deepseek', descriptorRevision: 1, implicitModelAliasReplacements: [],
      credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
      migratedEnvironmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }],
      retainedEnvironmentVariables: [],
    }] }] };
    const profiles = [
      { id: 'required', name: 'Required', environmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'literal' }],
        envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }], createdAt: 1, updatedAt: 1 },
      { id: 'classified', name: 'Classified', environmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'literal' }], createdAt: 1, updatedAt: 1 },
      { id: 'promoted', name: 'Promoted', environmentVariables: [{ name: 'DEPLOY_TOKEN', value: '${BOUND}', isSecret: true }], createdAt: 1, updatedAt: 1 },
      { id: 'fallback', name: 'Fallback', environmentVariables: [{ name: 'DEPLOY_TOKEN', value: '${BOUND:-literal}', isSecret: true }], createdAt: 1, updatedAt: 1 },
      { v: 2, id: 'slim-secret', name: 'Slim secret', extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'literal', isSecret: true }], createdAt: 1, updatedAt: 1 },
    ];
    const result = prepareLegacyProfileRecordsV1({ profiles, secretBindingsByProfileId: {
      promoted: { BOUND: 'secret-a' }, fallback: { BOUND: 'secret-a' },
    } }, options);
    expect(result.status).toBe('partial');
    expect(result.records.map((record) => record.id)).toEqual(['promoted']);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.reason === 'inline-secret-requires-promotion')
      .map((diagnostic) => diagnostic.profileId)).toEqual(['required', 'classified', 'fallback', 'slim-secret']);
  });

  it('refuses destructive transfer of identifiable references that the stored definition projection would discard', () => {
    const raw = { profiles: [{ v: 2, id: 'future-field', name: 'Future field', createdAt: 1, updatedAt: 1,
      futureConfig: { bootstrapCredentialRef: 'retained-secret' } },
    { v: 2, id: 'known', name: 'Known', createdAt: 1, updatedAt: 1, additiveDisplay: 'harmless' },
    { v: 2, id: 'stack-ref', name: 'Stack ref', createdAt: 1, updatedAt: 1 }],
      promptStacksV1: { v: 1, surfaces: { profilesById: { 'stack-ref': [{ id: 'entry', enabled: true,
        ref: { kind: 'doc', artifactId: 'doc' }, placement: 'system_append', future: { secretRef: 'private-ref' } }] } } } };
    const prepared = prepareLegacyProfileRecordsV1(raw);
    expect(prepared.status).toBe('partial');
    expect(prepared.records.map((record) => record.id)).toEqual(['known']);
    expect(prepared.diagnostics).toEqual(expect.arrayContaining([
      { profileId: 'future-field', index: 0, reason: 'unknown-secret-reference-carrier' },
      { profileId: 'stack-ref', reason: 'unknown-secret-reference-carrier' },
    ]));
    expect(raw.profiles[0]?.futureConfig).toEqual({ bootstrapCredentialRef: 'retained-secret' });
  });

  it('does not admit a tolerant Artifact body with discarded reference-bearing fields into a complete transfer', () => {
    const artifact = { artifactId: 'published', header: { kind: 'launch-profile.v1', profileId: 'profile', name: 'Profile' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'profile', name: 'Profile', createdAt: 1, updatedAt: 1,
        future: { bootstrapCredentialRef: 'retained-secret' } }, secretBindings: {} }) };
    const options = { artifactsById: new Map([['published', artifact]]) };
    expect(readLegacyProfileRecordsV1({ profiles: [{ artifactId: 'published' }] }, options).records).toHaveLength(1);
    const prepared = prepareLegacyProfileRecordsV1({ profiles: [{ artifactId: 'published' }] }, options);
    expect(prepared.status).toBe('partial');
    expect(prepared.records).toEqual([]);
    expect(prepared.diagnostics).toContainEqual({ profileId: 'profile', index: 0, reason: 'unknown-secret-reference-carrier' });
  });

  it('projects entity enablement, private attachments and bindings without changing the published document', () => {
    const artifact = { artifactId: 'published', header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1 },
        secretBindings: { SHARED_TOKEN: 'happier:shared-secret:v1:shared' } }) };
    const promptStack = [{ id: 'private-stack', ref: { kind: 'doc' as const, artifactId: 'private-doc' }, enabled: true,
      placement: 'system_append' as const }];
    const result = readAiLaunchProfileRecords([{ v: 1, id: 'shared', definition: { kind: 'artifact', artifactId: 'published' },
      enabled: false, promptStack, secretBindings: { PRIVATE_TOKEN: 'private-secret' } }], { artifactsById: new Map([['published', artifact]]) });
    expect(result.entries[0]).toMatchObject({ kind: 'slim', profile: { id: 'shared', enabled: false, promptStack,
      secretBindings: { SHARED_TOKEN: 'happier:shared-secret:v1:shared', PRIVATE_TOKEN: 'private-secret' } } });
    expect(JSON.parse(artifact.body)).not.toHaveProperty('promptStack');
    const mismatched = readAiLaunchProfileRecords([{ v: 1, id: 'other', definition: { kind: 'artifact', artifactId: 'published' },
      enabled: true, promptStack: [], secretBindings: {} }], { artifactsById: new Map([['published', artifact]]) });
    expect(mismatched.entries[0]?.kind).toBe('opaque');
    expect(mismatched.diagnostics).toEqual([{ index: 0, reason: 'identity_mismatch' }]);
  });

  it('never downgrades a future or malformed versioned row to a legacy profile just because id and name exist', async () => {
    const rows = [
      { v: 99, id: 'future', name: 'Future', artifactId: 'published', payload: { retain: true } },
      { v: 2, id: 'malformed', name: 'Malformed', artifactId: 'published', createdAt: -1, updatedAt: 1 },
    ];
    const artifact = { artifactId: 'published', access: 'view' as const, header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1 } }) };
    const result = readAiLaunchProfileCollection(rows, { artifactsById: new Map([['published', artifact]]) });
    expect(result.entries.map((entry) => entry.kind)).toEqual(['opaque', 'opaque']);
    expect(result.diagnostics).toEqual([{ index: 0, reason: 'future_version' }, { index: 1, reason: 'malformed' }]);
    expect(result.entries.map((entry) => entry.raw)).toEqual(rows);
    const reads: string[] = [];
    await loadAiLaunchProfileArtifacts(rows, { read: async (id) => { reads.push(id); return artifact; } });
    expect(reads).toEqual([]);
    expect(readAiLaunchProfileCollection(rows, { artifactsById: new Map([['published', artifact]]), includeShared: true })
      .entries.map((entry) => entry.kind)).toEqual(['opaque', 'opaque', 'slim']);
  });

  it('opens a Settings reference only from its authorized current Artifact without rewriting the raw row', () => {
    const reference = { artifactId: 'published', future: true };
    const artifact = { artifactId: 'published', header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' },
      body: JSON.stringify({ kind: 'launch-profile.v1', future: true, profile: { v: 2, id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1, future: true },
        secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' } }) };
    const opened = readAiLaunchProfileCollection([reference], { artifactsById: new Map([['published', artifact]]) });
    expect(opened.entries[0]).toMatchObject({ kind: 'slim', artifactId: 'published', profile: { id: 'shared' },
      secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' }, raw: reference });
    expect(opened.entries[0]?.kind !== 'opaque' && opened.entries[0]?.profile).toMatchObject({
      artifactId: 'published', secretBindings: { DEPLOY_TOKEN: 'happier:shared-secret:v1:deploy' },
    });
    expect(opened.raw).toEqual([reference]);
    expect(opened.entries[0]?.kind !== 'opaque' && opened.entries[0]?.profile).not.toHaveProperty('future');
    expect(readAiLaunchProfileCollection([reference]).entries[0]?.kind).toBe('opaque');
    expect(readAiLaunchProfileCollection([reference], { artifactsById: new Map() }).diagnostics)
      .toEqual([{ index: 0, reason: 'artifact_unavailable' }]);
  });

  it('hydrates referenced and current grant documents through the same Artifact reader, paging and deduplicating reads', async () => {
    const document = (artifactId: string, access: 'owner' | 'view') => ({ artifactId, access,
      header: { kind: 'launch-profile.v1', profileId: artifactId, name: artifactId },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: artifactId, name: artifactId, createdAt: 1, updatedAt: 1 } }),
      revision: { headerVersion: 1, bodyVersion: 2 } });
    const reads: string[] = [];
    const owned = document('owned', 'owner');
    const shared = document('shared', 'view');
    const resources = await loadAiLaunchProfileArtifacts([{ artifactId: 'owned' }, { artifactId: 'owned' }], {
      read: async (id) => { reads.push(id); return id === 'owned' ? owned : shared; },
      list: async (options) => options.cursor
        ? { items: [shared] }
        : { items: [owned, { artifactId: 'role', access: 'view', header: { kind: 'role.v1' } }], nextCursor: 'page-two' },
    });
    expect(reads).toEqual(['owned', 'shared']);
    const result = readAiLaunchProfileCollection([{ artifactId: 'owned' }], { artifactsById: resources, includeShared: true });
    expect(result.entries.filter((entry) => entry.kind !== 'opaque').map((entry) => entry.profile)).toMatchObject([
      { id: 'owned', artifactId: 'owned', shared: false },
      { id: 'shared', artifactId: 'shared', shared: true, viewOnly: true, revision: { headerVersion: 1, bodyVersion: 2 } },
    ]);
    expect(readAiLaunchProfileCollection([], { artifactsById: new Map(), includeShared: true }).entries).toEqual([]);
  });

  it('preserves valid legacy, slim, malformed, and future entries without rewriting them', () => {
    const entries = [
      { id: 'legacy', name: 'Legacy', environmentVariables: [], createdAt: 1, updatedAt: 1 },
      {
        v: 2, id: 'slim', name: 'Slim', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      },
      { v: 99, id: 'future', payload: { preserve: true } },
      { v: 2, id: '', malformed: true },
    ];
    const result = readAiLaunchProfileCollection(entries);
    expect(result.entries.map((entry) => entry.kind)).toEqual(['legacy', 'slim', 'opaque', 'opaque']);
    expect(result.raw).toEqual(entries);
    expect(result.diagnostics).toHaveLength(2);
  });

  it('classifies parsed launch profiles through one canonical discriminator', () => {
    const result = readAiLaunchProfileCollection([
      { id: 'legacy', name: 'Legacy', environmentVariables: [], createdAt: 1, updatedAt: 1 },
      {
        v: 2, id: 'slim', name: 'Slim', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      },
    ]);

    const legacy = result.entries[0];
    const slim = result.entries[1];
    expect(legacy?.kind).toBe('legacy');
    expect(slim?.kind).toBe('slim');
    if (legacy?.kind !== 'legacy' || slim?.kind !== 'slim') throw new Error('expected parsed profiles');
    expect(isLaunchProfileV2(legacy.profile)).toBe(false);
    expect(isLaunchProfileV2(slim.profile)).toBe(true);
  });

  it('removes the obsolete Gemini model pin from persisted historical profile rows at the shared read boundary', () => {
    const result = readAiLaunchProfileCollection([{
      id: 'gemini-api-key',
      name: 'Gemini (API key)',
      environmentVariables: [
        { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
        { name: 'TEAM_FLAG', value: '1' },
      ],
      createdAt: 1,
      updatedAt: 1,
    }]);

    const entry = result.entries[0];
    expect(entry?.kind).toBe('legacy');
    if (entry?.kind !== 'legacy') throw new Error('expected a legacy profile');
    expect(entry.profile.environmentVariables).toEqual([{ name: 'TEAM_FLAG', value: '1' }]);
    expect(result.raw).toEqual([expect.objectContaining({
      environmentVariables: expect.arrayContaining([{ name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' }]),
    })]);
  });

  it('projects the moving predecessor legacy coding-prompt override onto the canonical V2 override shape', () => {
    // Exact persisted shape written by remote-dev's legacy ProfileEditForm.
    const result = readAiLaunchProfileCollection([{
      id: 'remote-dev-profile',
      name: 'Remote Dev Profile',
      environmentVariables: [],
      envVarRequirements: [],
      defaultPermissionModeByTargetKey: {},
      defaultPermissionModeByAgent: {},
      defaultPersistenceModeByTargetKey: {},
      defaultPersistenceModeByAgent: {},
      compatibilityByTargetKey: {},
      compatibility: {},
      isBuiltIn: false,
      defaultEnabled: true,
      createdAt: 1,
      updatedAt: 1,
      version: '1.0.0',
      codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' },
    }]);

    const entry = result.entries[0];
    expect(entry?.kind).toBe('legacy');
    if (entry?.kind !== 'legacy') throw new Error('expected a legacy profile');
    expect(entry.profile).toMatchObject({
      codingPromptBehaviorOverrides: { responseOptions: 'disabled' },
    });
    expect(entry.profile.codingPromptBehaviorV1).toEqual({ v: 1, responseOptions: 'disabled' });
  });

  it('preserves bindings for persisted, opaque, pending, and historical built-in profiles without treating completion as a UI pruning signal', () => {
    const collection = readAiLaunchProfileCollection([
      { id: 'persisted', name: 'Persisted', environmentVariables: [], createdAt: 1, updatedAt: 1 },
      { v: 99, id: 'future', payload: { preserve: true } },
    ]);
    const migration = {
      v: 1 as const,
      completedSources: [{ sourceProfileId: 'deepseek', kind: 'default_environment' as const }],
      pendingCustomProfileIds: ['pending'],
    };

    for (const profileId of ['persisted', 'future', 'pending', 'gemini', 'gemini-api-key', 'azure-openai']) {
      expect(shouldPreserveLegacyAiLaunchProfileBindingV1({ profileId, collection, migration }), profileId).toBe(true);
    }
    expect(shouldPreserveLegacyAiLaunchProfileBindingV1({ profileId: 'deepseek', collection, migration })).toBe(true);
    expect(shouldPreserveLegacyAiLaunchProfileBindingV1({ profileId: 'absent-custom', collection, migration })).toBe(false);
  });
});
