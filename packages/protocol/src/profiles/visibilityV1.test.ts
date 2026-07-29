import { describe, expect, it } from 'vitest';

import { DEFAULT_BUILT_IN_BACKEND_PROFILES } from './builtInBackendProfiles.js';
import { resolveVisibleBuiltInAiLaunchProfilesV1 } from './visibilityV1.js';

function evidence(ids: readonly string[]) {
  return {
    lastUsedProfile: null,
    favoriteProfileIds: ids,
    profileEnabledById: {},
    secretBindingsByProfileId: {},
  };
}

describe('resolveVisibleBuiltInAiLaunchProfilesV1', () => {
  it('keeps only explicitly retained Azure and Gemini compatibility profiles in the generated catalog', () => {
    expect(DEFAULT_BUILT_IN_BACKEND_PROFILES.map((profile) => profile.id)).toEqual([
      'azure-openai',
      'gemini-api-key',
      'gemini-vertex',
    ]);
  });

  it('hides fresh and machine-login profiles, evidence-gates compatibility profiles, and honors terminal migration', () => {
    expect(resolveVisibleBuiltInAiLaunchProfilesV1({ evidence: evidence([]) })).toEqual([]);
    expect(resolveVisibleBuiltInAiLaunchProfilesV1({ evidence: evidence(['anthropic', 'deepseek', 'azure-openai']) })
      .map((profile) => profile.id)).toEqual(['azure-openai']);
    expect(resolveVisibleBuiltInAiLaunchProfilesV1({
      evidence: evidence(['deepseek', 'azure-openai']),
      migration: {
        v: 1,
        completedSources: [{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_deepseek' }],
        pendingCustomProfileIds: [],
        migratedAt: 2,
      },
    }).map((profile) => profile.id)).toEqual(['azure-openai']);
  });

  it('projects retained historical Gemini profiles without the obsolete model pin', () => {
    const profiles = resolveVisibleBuiltInAiLaunchProfilesV1({
      evidence: evidence(['gemini-api-key', 'gemini-vertex']),
    });

    expect(profiles.map((profile) => profile.id)).toEqual(['gemini-api-key', 'gemini-vertex']);
    expect(profiles.flatMap((profile) => profile.environmentVariables.map((entry) => entry.name)))
      .not.toContain('GEMINI_MODEL');
    expect(profiles.find((profile) => profile.id === 'gemini-vertex')?.environmentVariables)
      .toContainEqual({ name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' });
  });

  it('does not treat empty or malformed binding records as migration evidence', () => {
    const base = {
      lastUsedProfile: null,
      favoriteProfileIds: [],
      profileEnabledById: {},
    };
    expect(resolveVisibleBuiltInAiLaunchProfilesV1({
      evidence: { ...base, secretBindingsByProfileId: { deepseek: {} } },
    })).toEqual([]);
    for (const invalid of [' saved-secret-id ', 'saved\nsecret', 'x'.repeat(257)]) {
      expect(resolveVisibleBuiltInAiLaunchProfilesV1({
        evidence: { ...base, secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: invalid } } },
      })).toEqual([]);
    }
    expect(resolveVisibleBuiltInAiLaunchProfilesV1({
      evidence: { ...base, secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'saved-secret-id' } } },
    })).toEqual([]);
  });
});
