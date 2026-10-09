import { describe, expect, it } from 'vitest';

import {
  classifyProviderSettingsSubtreeV1,
  migrateProviderAccountSettingsV1,
} from './accountSettingsV1.js';
import { deleteProviderConnectionV1 } from '../settings/operationsV1.js';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '../settings/v1.js';

function candidate(connectionId: string) {
  return {
    kind: 'connection',
    sourceProfileId: 'deepseek',
    connection: {
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey: 'happier.deepseek/deepseek' },
      role: 'default',
      displayName: 'DeepSeek',
      displayNameMode: 'automatic',
      revision: 0,
      createdAt: 10,
      updatedAt: 10,
    },
    secretBindings: { account: { apiKey: 'saved-secret-id-unchanged' } },
    manualModels: [{ id: 'deepseek-chat', addedAt: 10 }],
    accountGrant: {
      v: 1,
      connectionId,
      connectionSecurityFingerprint: 'connection-security:v1:verified',
      confirmedAt: 10,
    },
  } as const;
}

describe('provider account-settings migration', () => {
  it('migrates an opened Provider catalog without creating a Settings entity root', () => {
    const basis = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{ ...candidate('pc-existing').connection, role: 'named', displayNameMode: 'custom' }],
      secretBindingsByConnectionId: { 'pc-existing': { byMachineId: { machine: { apiKey: 'existing-key' } } } },
    });
    const result = migrateProviderAccountSettingsV1(basis, {
      migratedAt: 20, candidates: [candidate('pc-new')], pendingCustomProfileIds: [],
    });
    expect(result).toMatchObject({ ok: true, providerSettings: {
      connections: [{ id: 'pc-existing' }, { id: 'pc-new' }],
      secretBindingsByConnectionId: {
        'pc-existing': { byMachineId: { machine: { apiKey: 'existing-key' } } },
        'pc-new': { account: { apiKey: 'saved-secret-id-unchanged' } },
      },
    } });
    expect(result).not.toHaveProperty('settings.providerSettingsV1');
  });
  it('contracts obsolete source completion and semantic tombstones while preserving unresolved conflicts', () => {
    const pending = { v: 1 as const, sourceProfileId: 'unresolved', contributionKey: 'happier.deepseek/deepseek',
      existingConnectionId: null, kinds: ['credential_binding' as const], modelChoices: [],
      candidateFingerprint: 'legacy-profile-migration-conflict:v1:unresolved', detectedAt: 1 };
    const basis = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      connectionTombstones: [{ v: 1, id: 'pc-deleted', contributionKey: 'happier.deepseek/deepseek',
        lastDisplayName: 'Deleted', deletedAt: 10 }],
      migration: { v: 1, completedSources: [{ sourceProfileId: 'gone', kind: 'connection', connectionId: 'pc-deleted' }],
        pendingCustomProfileIds: [], pendingConflicts: [pending], migratedAt: 10 },
    });
    const result = migrateProviderAccountSettingsV1(basis, {
      migratedAt: 20, candidates: [], pendingCustomProfileIds: [], retainedSourceProfileIds: [],
    });
    expect(result).toMatchObject({ ok: true, providerSettings: {
      connectionTombstones: [], migration: { completedSources: [], pendingConflicts: [pending] },
    } });
  });
  it('classifies only the provider subtree and never mistakes outer v6/v7 for provider versions', () => {
    expect(classifyProviderSettingsSubtreeV1({ schemaVersion: 6 })).toEqual({ kind: 'absent' });
    expect(classifyProviderSettingsSubtreeV1({ schemaVersion: 7 })).toEqual({ kind: 'absent' });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: { v: 2, opaque: true } }))
      .toEqual({ kind: 'future', version: 2 });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: { v: '1' } })).toEqual({ kind: 'malformed' });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: 'invalid' })).toEqual({ kind: 'malformed' });
  });

  it('preserves SavedSecret ids while migrating one preallocated candidate into the domain projection', () => {
    const raw = DEFAULT_PROVIDER_SETTINGS_V1;
    const result = migrateProviderAccountSettingsV1(raw, {
      migratedAt: 20,
      candidates: [candidate('pc_allocated_once')],
      pendingCustomProfileIds: ['company-gateway'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration success');
    expect(result.providerSettings).toMatchObject({
        connections: [{ id: 'pc_allocated_once' }],
        secretBindingsByConnectionId: { pc_allocated_once: { account: { apiKey: 'saved-secret-id-unchanged' } } },
        migration: {
          completedSources: [{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_allocated_once' }],
          pendingCustomProfileIds: ['company-gateway'], migratedAt: 20,
        },
    });
    expect(result.outcomes).toEqual([
      { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_allocated_once' },
    ]);
    expect((result.providerSettings as { connections: Array<{ source: { contributionKey: string } }> })
      .connections[0]?.source.contributionKey).toBe('happier.deepseek/deepseek');

    const repeated = migrateProviderAccountSettingsV1(result.providerSettings, {
      migratedAt: 999,
      candidates: [candidate('pc_allocated_once')],
      pendingCustomProfileIds: ['company-gateway'],
    });
    expect(repeated).toEqual({ ...result, changed: false });
  });

  it('converges a losing CAS retry on the winning default connection without duplicating identity', () => {
    const first = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: [candidate('pc_client_a')], pendingCustomProfileIds: [],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first migration success');

    const retry = migrateProviderAccountSettingsV1(first.providerSettings, {
      migratedAt: 21, candidates: [candidate('pc_client_b')], pendingCustomProfileIds: [],
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected retry success');
    expect((retry.providerSettings as any).connections.map((entry: any) => entry.id)).toEqual(['pc_client_a']);
    expect(retry.outcomes).toEqual([
      { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_client_a' },
    ]);
    expect(retry.changed).toBe(false);
  });

  it('repairs an already-completed current-Dev model target without replacing connection or secret identity', () => {
    const legacy = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{
        ...candidate('pc_existing'),
        selectedModel: { agentTargetKey: 'agent:claude', modelId: 'deepseek-chat' },
      }],
      pendingCustomProfileIds: [],
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error('expected legacy Provider migration');

    const repaired = migrateProviderAccountSettingsV1(legacy.providerSettings, {
      migratedAt: 30,
      candidates: [{
        ...candidate('pc_must_not_replace'),
        selectedModel: { agentTargetKey: 'backend:claude', modelId: 'deepseek-chat' },
      }],
      pendingCustomProfileIds: [],
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected Provider migration repair');
    expect(repaired.changed).toBe(true);
    expect((repaired.providerSettings as any).connections.map((entry: any) => entry.id))
      .toEqual(['pc_existing']);
    expect((repaired.providerSettings as any).secretBindingsByConnectionId).toEqual({
      pc_existing: { account: { apiKey: 'saved-secret-id-unchanged' } },
    });
    expect(repaired.outcomes).toContainEqual({
      sourceProfileId: 'deepseek',
      kind: 'connection',
      connectionId: 'pc_existing',
      modelSelection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_existing',
        modelId: 'deepseek-chat',
      },
    });
  });

  it('never retargets a losing candidate grant onto a concurrently-created winner', () => {
    const winner = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{ ...candidate('pc_winner'), accountGrant: undefined }],
      pendingCustomProfileIds: [],
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error('expected winner');
    const retried = migrateProviderAccountSettingsV1(winner.providerSettings, {
      migratedAt: 21,
      candidates: [{
        ...candidate('pc_loser'),
        sourceProfileId: 'deepseek-second-legacy-source',
        accountGrant: {
          v: 1,
          connectionId: 'pc_loser',
          connectionSecurityFingerprint: 'connection-security:v1:loser-endpoint',
          confirmedAt: 21,
        },
      }],
      pendingCustomProfileIds: [],
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('expected retry');
    expect((retried.providerSettings as any).accountGrants).toEqual([]);
  });

  it('refuses a conflicting secret binding instead of making candidate order the credential owner', () => {
    const winner = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: [candidate('pc_winner')], pendingCustomProfileIds: [],
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error('expected winner');
    const conflict = migrateProviderAccountSettingsV1(winner.providerSettings, {
      migratedAt: 21,
      candidates: [{
        ...candidate('pc_loser'),
        sourceProfileId: 'deepseek-second-legacy-source',
        secretBindings: { account: { apiKey: 'different-secret' } },
      }],
      pendingCustomProfileIds: [],
    });
    expect(conflict).toMatchObject({ ok: false, changed: false, reason: 'migration_conflict' });
  });

  it('reuses an existing equivalent manual model without treating its provenance timestamp as conflicting model data', () => {
    const winner = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: [candidate('pc_winner')], pendingCustomProfileIds: [],
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error('expected winner');
    const reused = migrateProviderAccountSettingsV1(winner.providerSettings, {
      migratedAt: 21,
      candidates: [{
        ...candidate('pc_loser'),
        sourceProfileId: 'deepseek-second-legacy-source',
        manualModels: [{ id: 'deepseek-chat', addedAt: 21 }],
      }],
      pendingCustomProfileIds: [],
    });
    expect(reused.ok).toBe(true);
    if (!reused.ok) throw new Error('expected equivalent model reuse');
    expect((reused.providerSettings as any).manualModelsByConnectionId.pc_winner)
      .toEqual([{ id: 'deepseek-chat', addedAt: 10 }]);
  });

  it('converges named custom connections by recorded source provenance, not structural guessing', () => {
    const customCandidate = (connectionId: string) => ({
      kind: 'connection',
      sourceProfileId: 'company-gateway',
      connection: {
        v: 1, id: connectionId,
        source: {
          kind: 'custom',
          template: {
            v: 1, name: 'Company Gateway',
            endpointTemplates: [{
              id: 'chat', protocol: 'openai-chat', baseUrl: 'https://azure.example/v1',
              capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
            }],
            catalog: { source: 'manual', manualModelPolicy: 'allowed' },
          },
        },
        role: 'named', displayName: 'Company Gateway', displayNameMode: 'custom', revision: 0, createdAt: 10, updatedAt: 10,
      },
    } as const);
    const winner = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: [customCandidate('pc_custom_a')], pendingCustomProfileIds: [],
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error('expected custom winner');
    const loserRetry = migrateProviderAccountSettingsV1(winner.providerSettings, {
      migratedAt: 21, candidates: [customCandidate('pc_custom_b')], pendingCustomProfileIds: [],
    });
    expect(loserRetry.ok).toBe(true);
    if (!loserRetry.ok) throw new Error('expected custom retry');
    expect((loserRetry.providerSettings as any).connections.map((entry: any) => entry.id)).toEqual(['pc_custom_a']);
    expect(loserRetry.outcomes.find((outcome) => outcome.sourceProfileId === 'company-gateway')).toEqual({
      sourceProfileId: 'company-gateway', kind: 'connection', connectionId: 'pc_custom_a',
    });
  });

  it('records default-environment completion and allows a later candidate after a no-candidate v3 pass', () => {
    const initial = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{ sourceProfileId: 'anthropic', kind: 'default_environment' }],
      pendingCustomProfileIds: [],
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error('expected initial migration');
    expect(initial.outcomes.find((outcome) => outcome.sourceProfileId === 'anthropic'))
      .toEqual({ sourceProfileId: 'anthropic', kind: 'default_environment' });

    const competingDefaultEnvironment = migrateProviderAccountSettingsV1(initial.providerSettings, {
      migratedAt: 999,
      candidates: [{ sourceProfileId: 'anthropic', kind: 'default_environment' }],
      pendingCustomProfileIds: [],
    });
    expect(competingDefaultEnvironment).toEqual({ ...initial, changed: false });

    const later = migrateProviderAccountSettingsV1(initial.providerSettings, {
      migratedAt: 21, candidates: [candidate('pc_later')], pendingCustomProfileIds: [],
    });
    expect(later.ok).toBe(true);
    if (!later.ok) throw new Error('expected later migration');
    expect(later.outcomes.find((outcome) => outcome.sourceProfileId === 'deepseek')).toEqual({
      sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_later',
    });
  });

  it('refuses malformed or future versions without rewriting their raw data', () => {
    for (const raw of [
      { schemaVersion: 6, keep: true, providerSettingsV1: { v: '1', preserve: 'malformed' } },
      { schemaVersion: 7, keep: true, providerSettingsV1: { v: 2, preserve: 'future' } },
    ]) {
      const result = migrateProviderAccountSettingsV1(raw.providerSettingsV1 as unknown as import('../settings/v1.js').ProviderSettingsV1, {
        migratedAt: 20, candidates: [], pendingCustomProfileIds: [],
      });
      expect(result.ok).toBe(false);
      expect(result.providerSettings).toEqual(raw.providerSettingsV1);
      expect(result.changed).toBe(false);
    }
  });

  it('refuses invalid nested candidate data as a stable result instead of throwing during final assembly', () => {
    const invalidCandidates = [
      { ...candidate('pc_bad_secret'), secretBindings: { account: { ' apiKey ': 'saved-secret' } } },
      { ...candidate('pc_bad_model'), manualModels: [{ id: '', addedAt: 1 }] },
      {
        ...candidate('pc_bad_grant'),
        accountGrant: {
          v: 1, connectionId: 'pc_bad_grant', connectionSecurityFingerprint: '', confirmedAt: 1,
        },
      },
    ];
    for (const invalid of invalidCandidates) {
      expect(() => migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
        migratedAt: 20,
        candidates: [invalid as ReturnType<typeof candidate>],
        pendingCustomProfileIds: [],
      })).not.toThrow();
      expect(migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
        migratedAt: 20,
        candidates: [invalid as ReturnType<typeof candidate>],
        pendingCustomProfileIds: [],
      })).toMatchObject({ ok: false, reason: 'migration_context_invalid', changed: false });
    }
  });

  it('keeps a completed source terminal after connection deletion and tombstone pruning', () => {
    const migrated = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: [candidate('pc_historical')], pendingCustomProfileIds: [],
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error('expected migration');
    const deleted = deleteProviderConnectionV1(
      ProviderSettingsV1Schema.parse(migrated.providerSettings),
      'pc_historical',
      30,
    );
    const pruned = ProviderSettingsV1Schema.parse({ ...deleted, connectionTombstones: [] });
    const rawAfterPrune = pruned;
    const rerun = migrateProviderAccountSettingsV1(rawAfterPrune, {
      migratedAt: 40, candidates: [candidate('pc_must_not_reappear')], pendingCustomProfileIds: [],
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('expected terminal completion');
    expect(rerun.changed).toBe(false);
    expect((rerun.providerSettings as any).connections).toEqual([]);
    expect(rerun.outcomes.find((outcome) => outcome.sourceProfileId === 'deepseek')).toEqual({
      sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_historical',
    });
  });

  it('preserves legacy source profile ids that coincide with object prototype keys', () => {
    const result = migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20,
      candidates: [{ sourceProfileId: '__proto__', kind: 'default_environment' }],
      pendingCustomProfileIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected prototype-key migration');
    expect(result.outcomes).toEqual([{ sourceProfileId: '__proto__', kind: 'default_environment' }]);
  });

  it('refuses a record-valid migration that exceeds the canonical decoded subtree budget', () => {
    const oversizedCandidates = Array.from({ length: 10 }, (_, connectionIndex) => {
      const connectionId = `pc_large_${connectionIndex}`;
      return {
        kind: 'connection' as const,
        sourceProfileId: `legacy-large-${connectionIndex}`,
        connection: {
          v: 1 as const,
          id: connectionId,
          source: { kind: 'contribution' as const, contributionKey: `happier.large/p-${connectionIndex}` },
          role: 'named' as const,
          displayName: `Large ${connectionIndex}`,
          displayNameMode: 'custom' as const,
          revision: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        manualModels: Array.from({ length: 500 }, (_, modelIndex) => {
          const suffix = `-${connectionIndex}-${modelIndex}`;
          return {
            id: `${'é'.repeat(512 - suffix.length)}${suffix}`,
            name: 'N'.repeat(256),
            addedAt: 1,
          };
        }),
      };
    });

    expect(() => migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: oversizedCandidates, pendingCustomProfileIds: [],
    })).not.toThrow();
    expect(migrateProviderAccountSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      migratedAt: 20, candidates: oversizedCandidates, pendingCustomProfileIds: [],
    })).toMatchObject({ ok: false, changed: false, reason: 'provider_settings_limit_exceeded' });
  });
});
