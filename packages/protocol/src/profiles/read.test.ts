import { describe, expect, it } from 'vitest';

import {
  isLaunchProfileV2,
  readAiLaunchProfileCollection,
  shouldPreserveLegacyAiLaunchProfileBindingV1,
} from './read.js';

describe('readAiLaunchProfileCollection', () => {
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
