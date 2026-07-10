import { describe, expect, it } from 'vitest';

import {
  classifyProviderSettingsSubtreeV1,
  migrateProviderAccountSettingsV1,
} from './accountSettingsV1.js';
import { deleteProviderConnectionV1 } from '../settings/operationsV1.js';
import { ProviderSettingsV1Schema } from '../settings/v1.js';

function candidate(connectionId: string) {
  return {
    kind: 'connection',
    sourceProfileId: 'deepseek',
    connection: {
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey: 'happier.deepseek:providers:deepseek' },
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
  it('classifies only the provider subtree and never mistakes outer v6/v7 for provider versions', () => {
    expect(classifyProviderSettingsSubtreeV1({ schemaVersion: 6 })).toEqual({ kind: 'absent' });
    expect(classifyProviderSettingsSubtreeV1({ schemaVersion: 7 })).toEqual({ kind: 'absent' });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: { v: 2, opaque: true } }))
      .toEqual({ kind: 'future', version: 2 });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: { v: '1' } })).toEqual({ kind: 'malformed' });
    expect(classifyProviderSettingsSubtreeV1({ providerSettingsV1: 'invalid' })).toEqual({ kind: 'malformed' });
  });

  it('preserves unknown account keys and SavedSecret ids while migrating one preallocated candidate', () => {
    const raw = { schemaVersion: 7, unknownFutureKey: { preserve: true }, savedSecrets: [{ id: 'saved-secret-id-unchanged' }] };
    const result = migrateProviderAccountSettingsV1(raw, {
      migratedAt: 20,
      candidates: [candidate('pc_allocated_once')],
      pendingCustomProfileIds: ['company-gateway'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected migration success');
    expect(result.settings).toMatchObject({
      schemaVersion: 7,
      unknownFutureKey: { preserve: true },
      savedSecrets: [{ id: 'saved-secret-id-unchanged' }],
      providerSettingsV1: {
        connections: [{ id: 'pc_allocated_once' }],
        secretBindingsByConnectionId: { pc_allocated_once: { account: { apiKey: 'saved-secret-id-unchanged' } } },
        migration: {
          completedSources: [{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_allocated_once' }],
          pendingCustomProfileIds: ['company-gateway'], migratedAt: 20,
        },
      },
    });
    expect(result.outcomes).toEqual([
      { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_allocated_once' },
    ]);

    const repeated = migrateProviderAccountSettingsV1(result.settings, {
      migratedAt: 999,
      candidates: [candidate('pc_allocated_once')],
      pendingCustomProfileIds: ['company-gateway'],
    });
    expect(repeated).toEqual({ ...result, changed: false });
  });

  it('converges a losing CAS retry on the winning default connection without duplicating identity', () => {
    const first = migrateProviderAccountSettingsV1({ schemaVersion: 6 }, {
      migratedAt: 20, candidates: [candidate('pc_client_a')], pendingCustomProfileIds: [],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first migration success');

    const retry = migrateProviderAccountSettingsV1(first.settings, {
      migratedAt: 21, candidates: [candidate('pc_client_b')], pendingCustomProfileIds: [],
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected retry success');
    expect((retry.settings.providerSettingsV1 as any).connections.map((entry: any) => entry.id)).toEqual(['pc_client_a']);
    expect(retry.outcomes).toEqual([
      { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_client_a' },
    ]);
    expect(retry.changed).toBe(false);
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
    const winner = migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
      migratedAt: 20, candidates: [customCandidate('pc_custom_a')], pendingCustomProfileIds: [],
    });
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error('expected custom winner');
    const loserRetry = migrateProviderAccountSettingsV1(winner.settings, {
      migratedAt: 21, candidates: [customCandidate('pc_custom_b')], pendingCustomProfileIds: [],
    });
    expect(loserRetry.ok).toBe(true);
    if (!loserRetry.ok) throw new Error('expected custom retry');
    expect((loserRetry.settings.providerSettingsV1 as any).connections.map((entry: any) => entry.id)).toEqual(['pc_custom_a']);
    expect(loserRetry.outcomes.find((outcome) => outcome.sourceProfileId === 'company-gateway')).toEqual({
      sourceProfileId: 'company-gateway', kind: 'connection', connectionId: 'pc_custom_a',
    });
  });

  it('records default-environment completion and allows a later candidate after a no-candidate v3 pass', () => {
    const initial = migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
      migratedAt: 20,
      candidates: [{ sourceProfileId: 'anthropic', kind: 'default_environment' }],
      pendingCustomProfileIds: [],
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error('expected initial migration');
    expect(initial.outcomes.find((outcome) => outcome.sourceProfileId === 'anthropic'))
      .toEqual({ sourceProfileId: 'anthropic', kind: 'default_environment' });

    const competingDefaultEnvironment = migrateProviderAccountSettingsV1(initial.settings, {
      migratedAt: 999,
      candidates: [{ sourceProfileId: 'anthropic', kind: 'default_environment' }],
      pendingCustomProfileIds: [],
    });
    expect(competingDefaultEnvironment).toEqual({ ...initial, changed: false });

    const later = migrateProviderAccountSettingsV1(initial.settings, {
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
      const result = migrateProviderAccountSettingsV1(raw, {
        migratedAt: 20, candidates: [], pendingCustomProfileIds: [],
      });
      expect(result.ok).toBe(false);
      expect(result.settings).toEqual(raw);
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
      expect(() => migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
        migratedAt: 20,
        candidates: [invalid as ReturnType<typeof candidate>],
        pendingCustomProfileIds: [],
      })).not.toThrow();
      expect(migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
        migratedAt: 20,
        candidates: [invalid as ReturnType<typeof candidate>],
        pendingCustomProfileIds: [],
      })).toMatchObject({ ok: false, reason: 'migration_context_invalid', changed: false });
    }
  });

  it('keeps a completed source terminal after connection deletion and tombstone pruning', () => {
    const migrated = migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
      migratedAt: 20, candidates: [candidate('pc_historical')], pendingCustomProfileIds: [],
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error('expected migration');
    const deleted = deleteProviderConnectionV1(
      ProviderSettingsV1Schema.parse(migrated.settings.providerSettingsV1),
      'pc_historical',
      30,
    );
    const pruned = ProviderSettingsV1Schema.parse({ ...deleted, connectionTombstones: [] });
    const rawAfterPrune = { ...migrated.settings, providerSettingsV1: pruned };
    const rerun = migrateProviderAccountSettingsV1(rawAfterPrune, {
      migratedAt: 40, candidates: [candidate('pc_must_not_reappear')], pendingCustomProfileIds: [],
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('expected terminal completion');
    expect(rerun.changed).toBe(false);
    expect((rerun.settings.providerSettingsV1 as any).connections).toEqual([]);
    expect(rerun.outcomes.find((outcome) => outcome.sourceProfileId === 'deepseek')).toEqual({
      sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_historical',
    });
  });

  it('preserves legacy source profile ids that coincide with object prototype keys', () => {
    const result = migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
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
          source: { kind: 'contribution' as const, contributionKey: `happier.large:providers:p-${connectionIndex}` },
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

    expect(() => migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
      migratedAt: 20, candidates: oversizedCandidates, pendingCustomProfileIds: [],
    })).not.toThrow();
    expect(migrateProviderAccountSettingsV1({ schemaVersion: 7 }, {
      migratedAt: 20, candidates: oversizedCandidates, pendingCustomProfileIds: [],
    })).toMatchObject({ ok: false, changed: false, reason: 'provider_settings_limit_exceeded' });
  });
});
