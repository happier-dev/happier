import { describe, expect, it } from 'vitest';
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

  it('resolves built-in profiles by id', () => {
    const result = resolveBackendProfile({ query: 'openai', customProfiles: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.id).toBe('openai');
    expect(result.profile.isBuiltIn).toBe(true);
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
