import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  PROVIDER_MIGRATION_SOURCE_PROFILE_IDS,
} from './builtInBackendProfiles.js';
import {
  AIBackendProfileSchema,
  SavedSecretSchema,
  getBuiltInBackendProfile,
  getRequiredConfigEnvVarNames,
  getMissingRequiredConfigEnvVarNames,
  getProfileEnvironmentVariables,
  getRequiredSecretEnvVarNames,
  isProfileCompatibleWithBackendTarget,
  isProfileCompatibleWithAgent,
  resolveBackendProfile,
} from './index.js';

describe('profiles (protocol)', () => {
  it('exports backend profile helpers from index', () => {
    expect({
      AIBackendProfileSchema,
      SavedSecretSchema,
      getBuiltInBackendProfile,
      resolveBackendProfile,
      isProfileCompatibleWithBackendTarget,
      isProfileCompatibleWithAgent,
      getRequiredSecretEnvVarNames,
      getRequiredConfigEnvVarNames,
      getMissingRequiredConfigEnvVarNames,
      getProfileEnvironmentVariables,
    }).toMatchObject({
      AIBackendProfileSchema: expect.anything(),
      SavedSecretSchema: expect.anything(),
      getBuiltInBackendProfile: expect.any(Function),
      resolveBackendProfile: expect.any(Function),
      isProfileCompatibleWithBackendTarget: expect.any(Function),
      isProfileCompatibleWithAgent: expect.any(Function),
      getRequiredSecretEnvVarNames: expect.any(Function),
      getRequiredConfigEnvVarNames: expect.any(Function),
      getMissingRequiredConfigEnvVarNames: expect.any(Function),
      getProfileEnvironmentVariables: expect.any(Function),
    });
  });

  it('resolves retained built-in profiles by id', () => {
    const result = resolveBackendProfile({ query: 'azure-openai', customProfiles: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.id).toBe('azure-openai');
    expect(result.profile.isBuiltIn).toBe(true);
  });

  it('keeps provider migration sources out of live built-in profile resolution', () => {
    expect(PROVIDER_MIGRATION_SOURCE_PROFILE_IDS).toContain('openai');
    expect(getBuiltInBackendProfile('openai')).toBeNull();
    expect(resolveBackendProfile({ query: 'openai', customProfiles: [] })).toEqual({
      ok: false,
      reason: 'not_found',
      query: 'openai',
    });
  });

  it('still resolves an explicitly persisted legacy provider profile for migration compatibility', () => {
    const persistedLegacyProfile = AIBackendProfileSchema.parse({
      id: 'openai',
      name: 'OpenAI (GPT-5)',
      environmentVariables: [{ name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' }],
      envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
      compatibilityByTargetKey: { 'agent:codex': true },
      isBuiltIn: true,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });

    expect(resolveBackendProfile({
      query: 'openai',
      customProfiles: [persistedLegacyProfile],
    })).toEqual({
      ok: true,
      profile: persistedLegacyProfile,
      resolvedBy: 'id',
    });
  });

  it('preserves Gemini built-in profile model defaults', () => {
    const geminiProfiles = DEFAULT_BUILT_IN_BACKEND_PROFILES.filter((profile) => (
      profile.compatibilityByTargetKey['agent:gemini'] === true
    ));

    expect(geminiProfiles.length).toBeGreaterThan(0);
    expect(geminiProfiles.find((profile) => profile.id === 'gemini-api-key')?.environmentVariables).toContainEqual({
      name: 'GEMINI_MODEL',
      value: 'gemini-2.5-pro',
    });
    expect(geminiProfiles.find((profile) => profile.id === 'gemini-vertex')?.environmentVariables).toContainEqual({
      name: 'GEMINI_MODEL',
      value: 'gemini-2.5-pro',
    });
  });

  it('defaults profiles to enabled unless explicitly disabled', () => {
    const enabledByDefault = AIBackendProfileSchema.parse({
      id: 'work',
      name: 'Work',
      environmentVariables: [],
      envVarRequirements: [],
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });
    const disabledByDefault = AIBackendProfileSchema.parse({
      id: 'long-tail',
      name: 'Long Tail',
      defaultEnabled: false,
      environmentVariables: [],
      envVarRequirements: [],
      isBuiltIn: true,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });

    expect(enabledByDefault.defaultEnabled).toBe(true);
    expect(disabledByDefault.defaultEnabled).toBe(false);
  });

  it('resolves custom profiles by id', () => {
    const customProfiles = [
      {
        id: 'work',
        name: 'Work',
        environmentVariables: [],
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
      },
    ];

    const result = resolveBackendProfile({ query: 'work', customProfiles });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.id).toBe('work');
    expect(result.profile.isBuiltIn).toBe(false);
  });

  it('resolves profiles by name (case-insensitive)', () => {
    const customProfiles = [
      {
        id: 'p1',
        name: 'My Work',
        environmentVariables: [],
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
      },
    ];

    const result = resolveBackendProfile({ query: 'my work', customProfiles });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.id).toBe('p1');
  });

  it('fails with an actionable ambiguity result when multiple names match', () => {
    const customProfiles = [
      {
        id: 'p1',
        name: 'Same Name',
        environmentVariables: [],
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
      },
      {
        id: 'p2',
        name: 'same name',
        environmentVariables: [],
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
      },
    ];

    const result = resolveBackendProfile({ query: 'same name', customProfiles });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe('ambiguous_name');
    expect(result.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(['p1', 'p2']));
  });

  it('implements UI-compatible compatibility semantics', async () => {
    const { isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget } = await import('./index.js');

    expect(
      isProfileCompatibleWithBackendTarget(
        { compatibilityByTargetKey: { 'agent:claude': true }, isBuiltIn: true },
        { kind: 'builtInAgent', agentId: 'claude' },
      ),
    ).toBe(true);
    expect(
      isProfileCompatibleWithBackendTarget(
        { compatibilityByTargetKey: { 'acpBackend:review': false }, isBuiltIn: false },
        { kind: 'configuredAcpBackend', backendId: 'review' },
      ),
    ).toBe(false);
    expect(
      isProfileCompatibleWithBackendTarget(
        { compatibilityByTargetKey: {}, isBuiltIn: true },
        { kind: 'builtInAgent', agentId: 'claude' },
      ),
    ).toBe(false);
    expect(
      isProfileCompatibleWithBackendTarget(
        { compatibilityByTargetKey: {}, isBuiltIn: false },
        { kind: 'configuredAcpBackend', backendId: 'review' },
      ),
    ).toBe(true);
    expect(isProfileCompatibleWithAgent({ compatibilityByTargetKey: { 'agent:claude': true }, isBuiltIn: true }, 'claude')).toBe(true);
  });

  it('returns required env var names (secret vs config)', async () => {
    const { getRequiredSecretEnvVarNames, getRequiredConfigEnvVarNames, getMissingRequiredConfigEnvVarNames } = await import('./index.js');

    const profile = {
      id: 'p1',
      name: 'Reqs',
      environmentVariables: [],
      envVarRequirements: [
        { name: 'OPENAI_API_KEY', kind: 'secret', required: true },
        { name: 'OPTIONAL_TOKEN', kind: 'secret', required: false },
        { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
      ],
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    };

    expect(getRequiredSecretEnvVarNames(profile)).toEqual(['OPENAI_API_KEY']);
    expect(getRequiredConfigEnvVarNames(profile)).toEqual(['GOOGLE_CLOUD_PROJECT']);
    expect(getMissingRequiredConfigEnvVarNames(profile, { GOOGLE_CLOUD_PROJECT: false })).toEqual(['GOOGLE_CLOUD_PROJECT']);
    expect(getMissingRequiredConfigEnvVarNames(profile, { GOOGLE_CLOUD_PROJECT: true })).toEqual([]);
  });
});
