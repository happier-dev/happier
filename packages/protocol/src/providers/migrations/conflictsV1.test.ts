import { describe, expect, it } from 'vitest';

import { DEFAULT_PROVIDER_SETTINGS_V1 } from '../settings/v1.js';
import { readProviderSettingsFromAccountSettingsV1 } from '../settings/readFromAccountSettingsV1.js';
import type { ProviderAccountSettingsMigrationContextV1 } from './accountSettingsV1.js';
import { migrateProviderAccountSettingsV1 } from './accountSettingsV1.js';
import { migrateLegacyAiLaunchProfilesV1 } from './legacyProfilesV1.js';
import { classifyLegacyProfileMigrationConflictsV1 } from './conflictsV1.js';
import { resolveLegacyProfileMigrationConflictV1 } from './conflictsV1.js';

function candidate(sourceProfileId: string, connectionId: string, secretId: string, modelName = 'Reasoner') {
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
    manualModels: [{ id: 'deepseek-reasoner', name: modelName, addedAt: 10 }],
    selectedModel: { agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner' },
  };
}

function context(candidates: ProviderAccountSettingsMigrationContextV1['candidates']): ProviderAccountSettingsMigrationContextV1 {
  return { migratedAt: 20, candidates, pendingCustomProfileIds: [] };
}

describe('classifyLegacyProfileMigrationConflictsV1', () => {
  it.each([
    ['forward', ['source-a', 'pc-a', 'secret-a'], ['source-b', 'pc-b', 'secret-b']],
    ['reverse', ['source-b', 'pc-b', 'secret-b'], ['source-a', 'pc-a', 'secret-a']],
  ] as const)('classifies same-batch credential conflicts independently of candidate order (%s)', (_label, left, right) => {
    const result = classifyLegacyProfileMigrationConflictsV1({}, context([
      candidate(...left),
      candidate(...right),
    ]));
    expect(result.candidates).toEqual([]);
    expect(result.pendingConflicts?.map((entry) => ({ sourceProfileId: entry.sourceProfileId, kinds: entry.kinds })))
      .toEqual([
        { sourceProfileId: 'source-a', kinds: ['credential_binding'] },
        { sourceProfileId: 'source-b', kinds: ['credential_binding'] },
      ]);
    expect(JSON.stringify(result.pendingConflicts)).not.toContain('secret-a');
    expect(JSON.stringify(result.pendingConflicts)).not.toContain('secret-b');
  });

  it('classifies persisted winner credential and model conflicts without exposing secret ids', () => {
    const rawSettings = {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          ...candidate('winner', 'pc-existing', 'existing-secret').connection,
          id: 'pc-existing',
        }],
        secretBindingsByConnectionId: { 'pc-existing': { account: { apiKey: 'existing-secret' } } },
        manualModelsByConnectionId: {
          'pc-existing': [{ id: 'deepseek-reasoner', name: 'Existing name', addedAt: 1 }],
        },
      },
    };
    const result = classifyLegacyProfileMigrationConflictsV1(
      rawSettings,
      context([candidate('deepseek', 'pc-candidate', 'legacy-secret', 'Legacy name')]),
    );
    expect(result.candidates).toEqual([]);
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        existingConnectionId: 'pc-existing',
        kinds: ['credential_binding', 'manual_model'],
      }),
    ]);
    const serialized = JSON.stringify(result.pendingConflicts);
    expect(serialized).not.toContain('existing-secret');
    expect(serialized).not.toContain('legacy-secret');
  });

  it('keeps identical same-batch facts eligible for deterministic merge', () => {
    const result = classifyLegacyProfileMigrationConflictsV1({}, context([
      candidate('source-a', 'pc-a', 'same-secret'),
      candidate('source-b', 'pc-b', 'same-secret'),
    ]));
    expect(result.pendingConflicts).toEqual([]);
    expect(result.candidates).toHaveLength(2);
  });

  it('is stable across independent coordinator invocations with new losing ids and timestamps', () => {
    const firstContext = classifyLegacyProfileMigrationConflictsV1({}, {
      migratedAt: 20,
      candidates: [
        candidate('source-a', 'pc-first-a', 'secret-a'),
        candidate('source-b', 'pc-first-b', 'secret-b'),
      ],
      pendingCustomProfileIds: [],
    });
    const first = migrateProviderAccountSettingsV1({}, firstContext);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first conflict persistence');

    const secondContext = classifyLegacyProfileMigrationConflictsV1(first.settings, {
      migratedAt: 999,
      candidates: [
        candidate('source-b', 'pc-second-b', 'secret-b'),
        candidate('source-a', 'pc-second-a', 'secret-a'),
      ],
      pendingCustomProfileIds: [],
    });
    expect(secondContext.pendingConflicts).toEqual(firstContext.pendingConflicts);
    expect(migrateProviderAccountSettingsV1(first.settings, secondContext)).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('removes a stale pending conflict when the source is no longer an eligible candidate', () => {
    const firstContext = classifyLegacyProfileMigrationConflictsV1({}, context([
      candidate('source-a', 'pc-a', 'secret-a'),
      candidate('source-b', 'pc-b', 'secret-b'),
    ]));
    const first = migrateProviderAccountSettingsV1({}, firstContext);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first migration');
    const reconciled = classifyLegacyProfileMigrationConflictsV1(first.settings, context([]));
    expect(reconciled.pendingConflicts).toEqual([]);
    const cleared = migrateProviderAccountSettingsV1(first.settings, reconciled);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected stale conflict cleanup');
    expect(readProviderSettingsFromAccountSettingsV1(cleared.settings).settings.migration?.pendingConflicts)
      .toEqual([]);
  });

  it('applies an exact-fingerprint keep-existing credential decision while preserving non-conflicting model intent', () => {
    const rawSettings = {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ ...candidate('winner', 'pc-existing', 'existing-secret').connection, id: 'pc-existing' }],
        secretBindingsByConnectionId: { 'pc-existing': { account: { apiKey: 'existing-secret' } } },
      },
    };
    const base = context([{
      ...candidate('deepseek', 'pc-loser', 'legacy-secret'),
      removedEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
      movedSecretBindingEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
    }]);
    const classified = classifyLegacyProfileMigrationConflictsV1(rawSettings, base);
    const conflict = classified.pendingConflicts?.[0];
    expect(conflict).toBeDefined();
    const resolved = resolveLegacyProfileMigrationConflictV1(rawSettings, base, {
      sourceProfileId: 'deepseek',
      expectedCandidateFingerprint: conflict!.candidateFingerprint,
      decision: { kind: 'keep_existing', existingConnectionId: 'pc-existing' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected reviewed resolution');
    expect(resolved.context.pendingConflicts).toEqual([]);
    expect(resolved.context.candidates).toEqual([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        connection: expect.objectContaining({ id: 'pc-existing' }),
        movedSecretBindingEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
      }),
    ]);
    expect(resolved.context.candidates[0]).not.toHaveProperty('secretBindings');
    expect(resolved.context.candidates[0]).toMatchObject({
      manualModels: [{ id: 'deepseek-reasoner', name: 'Reasoner' }],
      selectedModel: { agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner' },
    });

    const changedWinner = structuredClone(rawSettings);
    changedWinner.providerSettingsV1.secretBindingsByConnectionId['pc-existing']!.account.apiKey = 'third-secret';
    expect(resolveLegacyProfileMigrationConflictV1(changedWinner, base, {
      sourceProfileId: 'deepseek',
      expectedCandidateFingerprint: conflict!.candidateFingerprint,
      decision: { kind: 'keep_existing', existingConnectionId: 'pc-existing' },
    })).toMatchObject({ ok: false, reason: 'migration_conflict_changed' });
  });

  it('requires an explicit reviewed model outcome when keep-existing resolves a model conflict', () => {
    const rawSettings = {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ ...candidate('winner', 'pc-existing', 'same-secret').connection, id: 'pc-existing' }],
        manualModelsByConnectionId: {
          'pc-existing': [{ id: 'deepseek-reasoner', name: 'Existing', addedAt: 1 }],
        },
        defaultsByAgentTargetKey: {
          'agent:claude': {
            v: 1,
            ref: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc-existing', modelId: 'existing-model' },
            updatedAt: 1,
          },
        },
      },
    };
    const base = context([candidate('deepseek', 'pc-loser', 'same-secret', 'Legacy')]);
    const classified = classifyLegacyProfileMigrationConflictsV1(rawSettings, base);
    const conflict = classified.pendingConflicts![0]!;
    expect(conflict.modelChoices).toEqual([
      {
        kind: 'existing',
        selection: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
      },
      {
        kind: 'legacy',
        selection: { agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner' },
        label: 'Legacy',
      },
    ]);
    expect(resolveLegacyProfileMigrationConflictV1(rawSettings, base, {
      sourceProfileId: 'deepseek', expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: { kind: 'keep_existing', existingConnectionId: 'pc-existing' },
    })).toMatchObject({ ok: false, reason: 'migration_conflict_resolution_invalid' });
    const resolved = resolveLegacyProfileMigrationConflictV1(rawSettings, base, {
      sourceProfileId: 'deepseek', expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: {
        kind: 'keep_existing', existingConnectionId: 'pc-existing',
        modelSelection: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
      },
    });
    expect(resolved).toMatchObject({ ok: true, context: { candidates: [{
      selectedModel: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
    }] } });
    expect(resolveLegacyProfileMigrationConflictV1(rawSettings, base, {
      sourceProfileId: 'deepseek', expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: {
        kind: 'keep_existing', existingConnectionId: 'pc-existing',
        modelSelection: { agentTargetKey: 'agent:claude', modelId: 'arbitrary-unreviewed-model' },
      },
    })).toMatchObject({ ok: false, reason: 'migration_conflict_resolution_invalid' });
    const timestampOnly = structuredClone(rawSettings);
    timestampOnly.providerSettingsV1.defaultsByAgentTargetKey['agent:claude']!.updatedAt = 999;
    expect(classifyLegacyProfileMigrationConflictsV1(timestampOnly, base).pendingConflicts?.[0]?.candidateFingerprint)
      .toBe(conflict.candidateFingerprint);
    const changedWinner = structuredClone(rawSettings);
    changedWinner.providerSettingsV1.manualModelsByConnectionId['pc-existing']![0]!.name = 'Changed after review';
    expect(resolveLegacyProfileMigrationConflictV1(changedWinner, base, {
      sourceProfileId: 'deepseek', expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: {
        kind: 'keep_existing', existingConnectionId: 'pc-existing',
        modelSelection: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
      },
    })).toMatchObject({ ok: false, reason: 'migration_conflict_changed' });
  });

  it('maps favorite and last-used intent to the existing connection for a credential-only conflict', () => {
    const rawSettings = {
      profiles: [{
        id: 'deepseek', name: 'DeepSeek',
        environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }],
        envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
        createdAt: 1, updatedAt: 1,
      }],
      favoriteProfiles: ['deepseek'],
      lastUsedProfile: 'deepseek',
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'legacy-secret' } },
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ ...candidate('winner', 'pc-existing', 'existing-secret').connection, id: 'pc-existing' }],
        secretBindingsByConnectionId: { 'pc-existing': { account: { apiKey: 'existing-secret' } } },
      },
    };
    const base = context([{
      ...candidate('deepseek', 'pc-loser', 'legacy-secret'),
      removedEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
      movedSecretBindingEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
    }]);
    const conflict = classifyLegacyProfileMigrationConflictsV1(rawSettings, base).pendingConflicts![0]!;
    const reviewed = resolveLegacyProfileMigrationConflictV1(rawSettings, base, {
      sourceProfileId: 'deepseek', expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: { kind: 'keep_existing', existingConnectionId: 'pc-existing' },
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) throw new Error('expected reviewed resolution');
    const migrated = migrateLegacyAiLaunchProfilesV1(rawSettings, reviewed.context);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error('expected migration');
    expect(migrated.settings.favoriteProfiles).toEqual([]);
    expect(migrated.settings.lastUsedProfile).toBeNull();
    expect(migrated.settings.favoriteModelSelectionsV1).toEqual([expect.objectContaining({
      selection: expect.objectContaining({
        ref: {
          agentTargetKey: 'agent:claude', providerConnectionId: 'pc-existing', modelId: 'deepseek-reasoner',
        },
      }),
    })]);
    expect(migrated.settings.secretBindingsByProfileId).toEqual({});
    expect(readProviderSettingsFromAccountSettingsV1(migrated.settings).settings
      .secretBindingsByConnectionId['pc-existing'])
      .toEqual({ account: { apiKey: 'existing-secret' } });
  });

  it('creates a stable named contribution connection only after exact conflict review', () => {
    const base = context([
      candidate('source-a', 'pc-a', 'secret-a'),
      candidate('source-b', 'pc-b', 'secret-b'),
    ]);
    const classified = classifyLegacyProfileMigrationConflictsV1({}, base);
    const conflict = classified.pendingConflicts!.find((entry) => entry.sourceProfileId === 'source-a')!;
    const resolved = resolveLegacyProfileMigrationConflictV1({}, base, {
      sourceProfileId: 'source-a',
      expectedCandidateFingerprint: conflict.candidateFingerprint,
      decision: { kind: 'create_named', connectionId: 'pc-reviewed', displayName: 'Legacy DeepSeek' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected reviewed resolution');
    expect(resolved.context.candidates).toContainEqual(expect.objectContaining({
      sourceProfileId: 'source-a',
      connection: expect.objectContaining({ id: 'pc-reviewed', role: 'named', displayName: 'Legacy DeepSeek' }),
      secretBindings: { account: { apiKey: 'secret-a' } },
    }));
    expect(resolveLegacyProfileMigrationConflictV1({}, base, {
      sourceProfileId: 'source-a',
      expectedCandidateFingerprint: 'legacy-profile-migration-conflict:v1:stale',
      decision: { kind: 'create_named', connectionId: 'pc-reviewed', displayName: 'Legacy DeepSeek' },
    })).toMatchObject({ ok: false, reason: 'migration_conflict_changed' });
  });
});
