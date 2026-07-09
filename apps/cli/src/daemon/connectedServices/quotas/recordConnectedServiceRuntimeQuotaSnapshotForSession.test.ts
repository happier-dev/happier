import type { ConnectedServiceQuotaSnapshotV1, ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createProviderAccountUsageStore } from '../accountUsage/store';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './recordConnectedServiceRuntimeQuotaSnapshotForSession';

function createSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'primary',
    fetchedAt: 1_000,
    staleAfterMs: 300_000,
    providerId: 'codex',
    activeAccountId: 'acct_live_codex',
    planLabel: 'pro',
    accountLabel: 'live@example.test',
    source: 'in_band_provider_snapshot',
    confidence: 'exact',
    meters: [],
    ...overrides,
  };
}

function createExhaustedSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
  return createSnapshot({
    meters: [{
      meterId: 'primary',
      label: 'Primary',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100,
      remainingPct: 0,
      resetsAt: 10_000,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
    ...overrides,
  });
}

function createAccountUsageHarness(options: Readonly<{ persist?: boolean }> = {}) {
  const store = createProviderAccountUsageStore();
  const recordedSnapshots: ProviderAccountUsageSnapshotV1[] = [];
  const persistence = options.persist === false
    ? null
    : {
      recordInBandSnapshot: vi.fn(async (snapshot: ProviderAccountUsageSnapshotV1, _options?: unknown) => {
        recordedSnapshots.push(snapshot);
        return { status: 'enqueued' as const, enqueue: 'accepted' as const };
      }),
    };
  const publishRecordId = vi.fn(async () => {});

  return {
    accountUsageRecorder: {
      store,
      persistence,
      publishRecordId,
    },
    persistence,
    publishRecordId,
    recordedSnapshots,
    store,
  };
}

function currentGroupEnv(profileId = 'primary') {
  return {
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: profileId,
      fallbackProfileId: 'backup',
      generation: 7,
    }]),
  };
}

describe('recordConnectedServiceRuntimeQuotaSnapshotForSession', () => {
  it('records native runtime observations as provider account usage without entering connected-service policy', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createSnapshot({
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
      activeAccountId: 'acct_native_codex',
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_native',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'native' },
            },
          },
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      groupId: 'main',
      groupGeneration: 7,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_native',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    const recorded = accountUsage.store.listSnapshots()[0];
    expect(recorded).toMatchObject({
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_native_codex' },
      source: 'runtimeSignal',
      confidence: 'confirmed',
    });
    expect(accountUsage.persistence?.recordInBandSnapshot).toHaveBeenCalledOnce();
    expect(accountUsage.publishRecordId).toHaveBeenCalledWith({
      sessionId: 'sess_native',
      recordId: recorded?.recordId,
    });
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: snapshot.profileId,
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('records connected runtime observations as provider account usage with explicit group-member source context', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createExhaustedSnapshot();

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_connected',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: currentGroupEnv('primary'),
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      groupId: 'main',
      groupGeneration: 7,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    const bySource = accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
      groupGeneration: 7,
    });
    expect(bySource).toMatchObject({
      accountSubject: { kind: 'providerSubject', id: 'acct_live_codex' },
      meters: [expect.objectContaining({ utilizationPct: 100, remainingPct: 0 })],
    });
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
    expect(notifyAccountUsageChanged).toHaveBeenCalledWith({
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      groupGeneration: 7,
      recordId: bySource?.recordId,
      snapshot: bySource,
    });
  });

  it('records stale generation observations for display but does not let them drive connected-service policy', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createExhaustedSnapshot({
      profileId: 'fresh-member',
      activeAccountId: 'acct_stale_generation',
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_stale',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'fresh-member',
                groupId: 'main',
              },
            },
          },
          environmentVariables: currentGroupEnv('stale-member'),
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_stale',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'fresh-member',
      bindingKind: 'group_member',
      groupId: 'main',
      groupGeneration: 7,
    })).toBeNull();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('merges native and connected observations only with stable provider-subject evidence', async () => {
    const accountUsage = createAccountUsageHarness({ persist: false });
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_native',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: { 'openai-codex': { source: 'native' } },
          },
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      runtimeQuotaSnapshots,
      sessionId: 'sess_native',
      serviceId: 'openai-codex',
      snapshot: createSnapshot({
        profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
        activeAccountId: 'acct_shared_stable',
      }),
    });
    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_connected',
        pid: 456,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: currentGroupEnv('primary'),
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      groupId: 'main',
      groupGeneration: 7,
      runtimeQuotaSnapshots,
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      snapshot: createSnapshot({ activeAccountId: 'acct_shared_stable' }),
    });

    expect(accountUsage.store.listSnapshots()).toHaveLength(1);
    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
      groupGeneration: 7,
    })?.recordKey.accountSubjectId).toBe('acct_shared_stable');
  });

  it('keeps provisional native and connected subjects separate without stable provider-subject proof', async () => {
    const accountUsage = createAccountUsageHarness({ persist: false });
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_native',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: { 'openai-codex': { source: 'native' } },
          },
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      runtimeQuotaSnapshots,
      sessionId: 'sess_native',
      serviceId: 'openai-codex',
      snapshot: createSnapshot({
        profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
        activeAccountId: undefined,
        accountLabel: 'same@example.test',
      }),
    });
    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_connected',
        pid: 456,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: currentGroupEnv('primary'),
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      runtimeQuotaSnapshots,
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      snapshot: createSnapshot({
        activeAccountId: undefined,
        accountLabel: 'same@example.test',
      }),
    });

    expect(accountUsage.store.listSnapshots()).toHaveLength(2);
    expect(accountUsage.store.listSnapshots().map((snapshot) => snapshot.accountSubject.kind)).toEqual([
      'provisionalLocalSubject',
      'provisionalLocalSubject',
    ]);
  });
});
