import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '../../profiles/backendProfileSchema.js';

import {
  confirmLegacyAiLaunchProfileMigrationV1,
  createLegacyProfileMigrationSourceFingerprintV1,
  LegacyProfileReviewedMappingV1Schema,
  migrateLegacyAiLaunchProfilesV1,
} from './legacyProfilesV1.js';

function connectionCandidate(sourceProfileId: string, connectionId: string, secretId = 'secret-a') {
  return {
    kind: 'connection' as const,
    sourceProfileId,
    connection: {
      v: 1 as const,
      id: connectionId,
      source: { kind: 'contribution' as const, contributionKey: 'happier.provider.deepseek:providers:deepseek' },
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

describe('migrateLegacyAiLaunchProfilesV1', () => {
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
    const result = migrateLegacyAiLaunchProfilesV1(raw, {
      migratedAt: 20,
      candidates: [connectionCandidate('deepseek', 'pc-deepseek')],
      pendingCustomProfileIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration');
    expect(result.settings).toMatchObject({
      schemaVersion: 7,
      unknown: { preserve: true },
      savedSecrets: [{ id: 'secret-a', opaque: true }],
      providerSettingsV1: {
        connections: [{ id: 'pc-deepseek' }],
        secretBindingsByConnectionId: { 'pc-deepseek': { account: { apiKey: 'secret-a' } } },
      },
      lastUsedProfile: 'deepseek',
      favoriteProfiles: [],
    });
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
    expect((settings.providerSettingsV1 as any).defaultsByAgentTargetKey).toEqual({});
  });

  it('records explicit disabled intent terminally and leaves no-evidence sources untouched', () => {
    const disabled = migrateLegacyAiLaunchProfilesV1({
      schemaVersion: 6,
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
      profileEnabledById: { deepseek: false },
      favoriteProfiles: ['deepseek'],
    }, {
      migratedAt: 20,
      candidates: [{ kind: 'skipped_disabled', sourceProfileId: 'deepseek' }],
      pendingCustomProfileIds: [],
    });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) throw new Error('expected disabled migration');
    expect((disabled.settings.providerSettingsV1 as any).migration.completedSources).toContainEqual({
      sourceProfileId: 'deepseek', kind: 'skipped_disabled',
    });
    expect((disabled.settings.providerSettingsV1 as any).connections).toEqual([]);
    expect((disabled.settings.profiles as any[])[0].id).toBe('deepseek');
    expect(disabled.settings.favoriteProfiles).toEqual(['deepseek']);

    const noEvidence = migrateLegacyAiLaunchProfilesV1({
      schemaVersion: 7,
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
    }, { migratedAt: 20, candidates: [], pendingCustomProfileIds: [] });
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
      const result = migrateLegacyAiLaunchProfilesV1({ schemaVersion: 7 }, {
        migratedAt: 20,
        candidates,
        pendingCustomProfileIds: [],
      });
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
    const result = migrateLegacyAiLaunchProfilesV1(raw, { migratedAt: 20, candidates: [], pendingCustomProfileIds: [] });
    expect(result).toEqual({ ok: true, changed: false, settings: raw, outcomes: [] });
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
      rawSettings: raw, sourceProfileId: 'company', reviewedMapping,
    });
    const mismatchedCredentialStyle = structuredClone(reviewedMapping);
    mismatchedCredentialStyle.credentialMoves[0]!.credentialStyle = 'x-api-key' as const;
    expect(LegacyProfileReviewedMappingV1Schema.safeParse(mismatchedCredentialStyle).success).toBe(false);
    const changedBinding = structuredClone(raw);
    changedBinding.secretBindingsByProfileId.company.COMPANY_API_KEY = 'secret-b';
    expect(confirmLegacyAiLaunchProfileMigrationV1({
      rawSettings: changedBinding,
      sourceProfileId: 'company', expectedSourceFingerprint: fingerprint, reviewedMapping, migratedAt: 20,
    })).toMatchObject({ ok: false, changed: false, reason: 'legacy_profile_source_changed' });

    const malformedBinding = structuredClone(raw);
    malformedBinding.secretBindingsByProfileId.company.COMPANY_API_KEY = ' secret-a ';
    const malformedFingerprint = createLegacyProfileMigrationSourceFingerprintV1({
      rawSettings: malformedBinding, sourceProfileId: 'company', reviewedMapping,
    });
    expect(confirmLegacyAiLaunchProfileMigrationV1({
      rawSettings: malformedBinding,
      sourceProfileId: 'company', expectedSourceFingerprint: malformedFingerprint, reviewedMapping, migratedAt: 20,
    })).toMatchObject({ ok: false, changed: false, reason: 'legacy_profile_source_changed' });

    const confirmed = confirmLegacyAiLaunchProfileMigrationV1({
      rawSettings: raw,
      sourceProfileId: 'company', expectedSourceFingerprint: fingerprint, reviewedMapping, migratedAt: 20,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('expected confirmed migration');
    expect(confirmed.settings).toMatchObject({
      providerSettingsV1: {
        connections: [{ id: 'pc-company' }],
        secretBindingsByConnectionId: { 'pc-company': { account: { apiKey: 'secret-a' } } },
        manualModelsByConnectionId: { 'pc-company': [{ id: 'company-model' }] },
      },
      profiles: [{
        v: 2,
        id: 'company',
        extraEnvironmentVariables: [{ name: 'RETAINED_TOKEN', value: '${RETAINED_TOKEN}' }],
        envVarRequirements: [{ name: 'RETAINED_TOKEN', kind: 'secret', required: true }],
      }],
      secretBindingsByProfileId: { company: { RETAINED_TOKEN: 'secret-retained' } },
    });
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
      }, {
        migratedAt: 20,
        candidates: [{
          ...base,
          sourceProfileId: fixture.id,
          connection: {
            ...base.connection,
            id: `pc-${fixture.id}`,
            source: { kind: 'contribution', contributionKey: `happier.provider.${fixture.id}:providers:${fixture.id}` },
          },
          selectedModel: { agentTargetKey: fixture.agentTargetKey, modelId: fixture.modelId },
          manualModels: [{ id: fixture.modelId, addedAt: 20 }],
        }],
        pendingCustomProfileIds: [],
      });
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
    }, {
      migratedAt: 20,
      candidates: [{ kind: 'default_environment', sourceProfileId: 'anthropic' }],
      pendingCustomProfileIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration');
    expect(Object.prototype.hasOwnProperty.call(result.settings.secretBindingsByProfileId, '__proto__')).toBe(true);
    expect((result.settings.secretBindingsByProfileId as Record<string, unknown>)['__proto__'])
      .toEqual({ TOKEN: 'secret-id' });
    expect(Object.prototype.hasOwnProperty.call(result.settings.profileEnabledById, '__proto__')).toBe(true);
    expect((result.settings.profileEnabledById as Record<string, unknown>)['__proto__']).toBe(true);
  });
});
