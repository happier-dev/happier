import type { ConnectedServiceQuotaSnapshotV1, ProviderAccountUsageDiagnosticV1, ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { createProviderAccountUsagePersistenceScheduler } from '../../accountUsage/persistence';
import { createProviderAccountUsageStore } from '../../accountUsage/store';
import { recordFetchedQuotaSnapshotAsAccountUsage } from './recordFetchedQuotaSnapshotAsAccountUsage';

describe('recordFetchedQuotaSnapshotAsAccountUsage', () => {
  it.each([
    { fetchedAt: 1_000 },
    { fetchedAt: 500, fetchedAtMs: 1_000 },
    { fetchedAt: 0 },
  ])('persists repeated failed refreshes while retaining observation time %j', async (times) => {
    const store = createProviderAccountUsageStore();
    const writes: Parameters<NonNullable<import('../../accountUsage/persistence').ProviderAccountUsageApi['registerProviderAccountUsageSnapshotPlain']>>[0][] = [];
    const persistence = createProviderAccountUsagePersistenceScheduler({
      api: { getAccountEncryptionMode: async () => 'plain', registerProviderAccountUsageSnapshotPlain: async (write) => { writes.push(write); } },
      now: () => 5_000, fingerprintKey: new Uint8Array(32),
    });
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1, serviceId: 'openai-codex', profileId: 'primary', ...times, staleAfterMs: 300_000,
      providerId: 'codex', activeAccountId: 'acct_live_codex', planLabel: null, accountLabel: null,
      source: 'background_fetch', confidence: 'exact', meters: times.fetchedAt === 0 ? [] : [{
        meterId: 'weekly', label: 'Weekly', used: 20, limit: 100, unit: 'requests',
        utilizationPct: 20, remainingPct: 80, resetsAt: null, status: 'ok', details: {},
      }],
    };
    const context = { accountUsageStore: store, accountUsagePersistence: persistence,
      quotaFingerprintHmacKey: new Uint8Array(32), persistQuotaSnapshotWithServerWork: async () => {},
      handleAccountUsageChanged: async () => {} };
    const profileSource = { serviceId: 'openai-codex', profileId: 'primary', bindingKind: 'profile' } as const;
    try {
      for (const now of [3_000, 4_000]) {
        const refreshError: ProviderAccountUsageDiagnosticV1 = {
          kind: 'provider_http', code: 'quota_rate_limited', status: 429, observedAtMs: now,
        };
        await recordFetchedQuotaSnapshotAsAccountUsage(context, {
          serviceId: 'openai-codex', profileId: 'primary', snapshot, now,
          sourceProviderAccountId: 'acct_live_codex', refreshError,
        });
        await persistence.flush(1_000);
        expect(store.resolveBySource(profileSource)).toMatchObject({
          fetchedAtMs: times.fetchedAtMs ?? times.fetchedAt, observedAtMs: now,
          state: 'error_last_known_good', diagnostics: [refreshError], meters: snapshot.meters,
        });
      }
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({ source: profileSource,
        metadata: { fetchedAt: times.fetchedAtMs ?? times.fetchedAt, status: 'error' },
        content: { v: { state: 'error_last_known_good', fetchedAtMs: times.fetchedAtMs ?? times.fetchedAt } },
      });
      expect(writes[1].metadata).not.toHaveProperty('refreshErrorAt');
    } finally { persistence.dispose(); }
  });

  it('does not grant a profile link for failure data without credential identity proof', async () => {
    const store = createProviderAccountUsageStore();
    const writes: ProviderAccountUsageSnapshotV1[] = [];
    const persistence = createProviderAccountUsagePersistenceScheduler({
      api: { getAccountEncryptionMode: async () => 'plain', registerProviderAccountUsageSnapshotPlain: async ({ content, source }) => {
        expect(source).toBeUndefined();
        writes.push(content.v);
      } }, now: () => 2_000, fingerprintKey: new Uint8Array(32),
    });
    try {
      await recordFetchedQuotaSnapshotAsAccountUsage({ accountUsageStore: store, accountUsagePersistence: persistence,
        quotaFingerprintHmacKey: new Uint8Array(32), persistQuotaSnapshotWithServerWork: async () => {}, handleAccountUsageChanged: async () => {},
      }, { serviceId: 'openai-codex', profileId: 'primary', now: 2_000,
        refreshError: { kind: 'unavailable', code: 'quota_refresh_failed', observedAtMs: 2_000 },
        snapshot: { v: 1, serviceId: 'openai-codex', profileId: 'primary', fetchedAt: 0, staleAfterMs: 300_000,
          activeAccountId: 'unverified', planLabel: null, accountLabel: null, meters: [] },
      });
      await persistence.flush(1_000);
      expect(writes).toHaveLength(1);
      expect(writes[0].state).toBe('error_last_known_good');
      expect(store.resolveBySource({ serviceId: 'openai-codex', profileId: 'primary', bindingKind: 'profile' })).toBeNull();
    } finally { persistence.dispose(); }
  });

  it('reports persistence intake failure while retaining the local observation', async () => {
    const persistence = createProviderAccountUsagePersistenceScheduler({
      api: { getAccountEncryptionMode: async () => 'plain', registerProviderAccountUsageSnapshotPlain: async () => {} },
      now: () => 2_000, fingerprintKey: new Uint8Array(32),
    });
    persistence.dispose();
    const warn = vi.spyOn(logger, 'warnFile');
    try {
      await expect(recordFetchedQuotaSnapshotAsAccountUsage({
        accountUsageStore: createProviderAccountUsageStore(), accountUsagePersistence: persistence,
        quotaFingerprintHmacKey: new Uint8Array(32), persistQuotaSnapshotWithServerWork: async () => {},
        handleAccountUsageChanged: async () => {},
      }, {
        serviceId: 'openai-codex', profileId: 'primary', now: 2_000,
        snapshot: { v: 1, serviceId: 'openai-codex', profileId: 'primary', fetchedAt: 1_000,
          staleAfterMs: 300_000, planLabel: null, accountLabel: null, meters: [] },
      })).resolves.toMatchObject({ fetchedAtMs: 1_000, observedAtMs: 2_000, state: 'loaded_empty' });
      expect(warn).toHaveBeenCalledWith(expect.any(String), { serviceId: 'openai-codex', profileId: 'primary' });
    } finally {
      warn.mockRestore();
    }
  });

  it('acknowledges an identical poll without persisting or notifying policy twice', async () => {
    const store = createProviderAccountUsageStore();
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
    const persistence = createProviderAccountUsagePersistenceScheduler({
      api: { getAccountEncryptionMode: async () => 'plain', registerProviderAccountUsageSnapshotPlain },
      now: () => 1_000, fingerprintKey: new Uint8Array(32),
    });
    const handleAccountUsageChanged = vi.fn(async () => {});
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: null,
      accountLabel: null,
      source: 'background_fetch',
      confidence: 'exact',
      meters: [],
    };
    const context = {
      accountUsageStore: store,
      accountUsagePersistence: persistence,
      quotaFingerprintHmacKey: new Uint8Array(32),
      persistQuotaSnapshotWithServerWork: vi.fn(async () => {}),
      handleAccountUsageChanged,
    };
    const input = {
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      snapshot,
      now: 1_000,
      sourceProviderAccountId: 'acct_live_codex',
      groupTargets: [{
        sessionId: 'sess_connected',
        serviceId: 'openai-codex' as const,
        groupId: 'main',
        activeProfileId: 'primary',
        groupGeneration: 7,
      }],
    };

    await recordFetchedQuotaSnapshotAsAccountUsage(context, input);
    await recordFetchedQuotaSnapshotAsAccountUsage(context, input);

    await persistence.flush(1_000);
    persistence.dispose();
    expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
    expect(handleAccountUsageChanged).toHaveBeenCalledOnce();
  });
});
