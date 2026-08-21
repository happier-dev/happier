import type { ConnectedServiceQuotaSnapshotV1, ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createProviderAccountUsageStore } from '../accountUsage/store';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './recordConnectedServiceRuntimeQuotaSnapshotForSession';
import { resolveQuotaProbeFreshProof } from './proof/quotaProbeFreshProof';

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
      recordInBandSnapshot: vi.fn(async (snapshot: ProviderAccountUsageSnapshotV1) => {
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
  it('does not acknowledge canonical quota intake when persistence cannot take custody', async () => {
    const accountUsage = createAccountUsageHarness();
    accountUsage.persistence!.recordInBandSnapshot.mockRejectedValueOnce(
      new Error('provider_account_usage_persistence_disposed'),
    );

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_persistence_rejected',
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
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      sessionId: 'sess_persistence_rejected',
      serviceId: 'openai-codex',
      snapshot: createSnapshot(),
    })).rejects.toThrow('provider_account_usage_persistence_disposed');
  });

  it('routes an exact immutable provider-operation identity through quota proof into recovery', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const recordQuotaProbeFreshProof = vi.fn(async () => {});
    const resolveExpectedQuotaProbeAppliedIdentity = vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      groupId: 'main',
      groupGeneration: 7,
      providerAccountId: 'acct_live_codex',
      materialFingerprint: 'sha256:abcdef12',
    }));
    const snapshot = createSnapshot({
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 10,
        limit: 100,
        unit: 'requests',
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_quota_proof',
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
      runtimeQuotaSnapshots,
      sessionId: 'sess_quota_proof',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      policyDisposition: 'evidence_only',
      verifyCredentialFingerprint: async () => true,
      resolveCurrentGroupGenerationForProfile: async () => 7,
      resolveExpectedQuotaProbeAppliedIdentity,
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    });

    await vi.waitFor(() => expect(resolveExpectedQuotaProbeAppliedIdentity).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recordQuotaProbeFreshProof).toHaveBeenCalledWith({
      sessionId: 'sess_quota_proof',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      proofKind: 'quota_probe_fresh',
      observedAtMs: 1_000,
    }));

    recordQuotaProbeFreshProof.mockClear();
    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_quota_proof',
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
      runtimeQuotaSnapshots,
      sessionId: 'sess_quota_proof',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      sourceProviderAccountId: 'acct_drifted',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      resolveExpectedQuotaProbeAppliedIdentity: async () => ({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 7,
        providerAccountId: 'acct_live_codex',
        materialFingerprint: 'sha256:abcdef12',
      }),
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    });
    expect(recordQuotaProbeFreshProof).not.toHaveBeenCalled();

    await recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_quota_proof',
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
      runtimeQuotaSnapshots,
      sessionId: 'sess_quota_proof',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7.9,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      resolveCurrentGroupGenerationForProfile: async () => 7,
      resolveExpectedQuotaProbeAppliedIdentity: async () => ({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 7,
        providerAccountId: 'acct_live_codex',
        materialFingerprint: 'sha256:abcdef12',
      }),
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    });
    expect(recordQuotaProbeFreshProof).not.toHaveBeenCalled();
  });

  it('keeps canonical quota recording and policy notification when optional proof settlement fails', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const recordQuotaProbeFreshProof = vi.fn(async () => {
      throw new Error('proof store unavailable');
    });
    const snapshot = createSnapshot({
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 10,
        limit: 100,
        unit: 'requests',
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_proof_failure',
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
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_proof_failure',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      resolveCurrentGroupGenerationForProfile: async () => 7,
      resolveExpectedQuotaProbeAppliedIdentity: async () => ({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 7,
        providerAccountId: 'acct_live_codex',
        materialFingerprint: 'sha256:abcdef12',
      }),
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    })).resolves.toEqual({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
      quotaStateRecorded: true,
    });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
    expect(notifyAccountUsageChanged).toHaveBeenCalledOnce();
    expect(recordQuotaProbeFreshProof).toHaveBeenCalledOnce();
  });

  it('returns after canonical recording without waiting for policy or proof settlement', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    let releasePolicy!: () => void;
    let releaseProof!: () => void;
    const policyBarrier = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const proofBarrier = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    const notifyAccountUsageChanged = vi.fn(async () => await policyBarrier);
    const recordQuotaProbeFreshProof = vi.fn(async () => await proofBarrier);
    const snapshot = createSnapshot({
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 10,
        limit: 100,
        unit: 'requests',
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    const recording = recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_fast_intake',
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
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_fast_intake',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      resolveCurrentGroupGenerationForProfile: async () => 7,
      resolveExpectedQuotaProbeAppliedIdentity: async () => ({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 7,
        providerAccountId: 'acct_live_codex',
        materialFingerprint: 'sha256:abcdef12',
      }),
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    });

    await expect(Promise.race([
      recording,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ])).resolves.toEqual({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
      quotaStateRecorded: true,
    });
    expect(notifyAccountUsageChanged).toHaveBeenCalledOnce();
    releasePolicy();
    await vi.waitFor(() => expect(recordQuotaProbeFreshProof).toHaveBeenCalledOnce());
    releaseProof();
  });

  it('records native runtime observations as provider account usage without entering connected-service policy or fanout', async () => {
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
    expect(accountUsage.publishRecordId).not.toHaveBeenCalled();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: snapshot.profileId,
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('records connected runtime observations as provider account usage and keeps only current-generation compatibility projection', async () => {
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
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
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
      source: 'in_band',
    });
  });

  it('rejects a delayed same-profile snapshot before any mutation when its credential fingerprint is no longer current', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const verifyCredentialFingerprint = vi.fn(async () => false);
    const snapshot = createExhaustedSnapshot();

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_credential_aba',
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
      credentialFingerprint: 'sha256:deadbeef',
      verifyCredentialFingerprint,
      groupId: 'main',
      groupGeneration: 7,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_credential_aba',
      serviceId: 'openai-codex',
      sourceProviderAccountId: 'acct_live_codex',
      snapshot,
    })).resolves.toMatchObject({
      status: 'credential_fingerprint_mismatch',
      persisted: false,
    });

    expect(verifyCredentialFingerprint).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      providerAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:deadbeef',
    });
    expect(verifyCredentialFingerprint).toHaveBeenCalledOnce();
    expect(accountUsage.store.listSnapshots()).toEqual([]);
    expect(accountUsage.persistence?.recordInBandSnapshot).not.toHaveBeenCalled();
    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
      groupGeneration: 7,
    })).toBeNull();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('retries instead of terminally rejecting a quota snapshot when credential verification is unavailable', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_verifier_unavailable',
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
      runtimeQuotaSnapshots,
      sessionId: 'sess_verifier_unavailable',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => {
        throw new Error('credential store unavailable');
      },
      snapshot: createSnapshot(),
    })).rejects.toThrow('credential store unavailable');

    expect(accountUsage.persistence?.recordInBandSnapshot).not.toHaveBeenCalled();
  });

  it('lets the persistence owner dedupe identical delivery without notifying policy twice', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createExhaustedSnapshot();
    const input = {
      getChildren: () => [{
        startedBy: 'daemon' as const,
        happySessionId: 'sess_connected',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1 as const,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
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
      serviceId: 'openai-codex' as const,
      sourceProviderAccountId: 'acct_live_codex',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      snapshot,
    };

    await recordConnectedServiceRuntimeQuotaSnapshotForSession(input);
    await recordConnectedServiceRuntimeQuotaSnapshotForSession(input);

    expect(accountUsage.persistence?.recordInBandSnapshot).toHaveBeenCalledTimes(2);
    expect(notifyAccountUsageChanged).toHaveBeenCalledOnce();
  });

  it('records connected runtime usage facts but strips source links when the source owner differs from the live account', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createExhaustedSnapshot({
      activeAccountId: 'acct_live_after_switch',
    });

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
      sourceProviderAccountId: 'acct_connected_profile',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(accountUsage.store.listSnapshots()).toEqual([
      expect.objectContaining({
        accountSubject: { kind: 'providerSubject', id: 'acct_live_after_switch' },
      }),
    ]);
    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
      groupGeneration: 7,
    })).toBeNull();
    expect(accountUsage.persistence?.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      accountSubject: { kind: 'providerSubject', id: 'acct_live_after_switch' },
    }), undefined);
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
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
      sourceProviderAccountId: 'acct_stale_generation',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'fresh-member',
      bindingKind: 'group_member',
      groupId: 'main',
    })?.recordKey.accountSubjectId).toBe('acct_stale_generation');
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('keeps delayed same-profile snapshots from an older generation out of connected-service policy', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const snapshot = createExhaustedSnapshot({
      profileId: 'primary',
      activeAccountId: 'acct_old_generation',
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_delayed',
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
      groupGeneration: 6,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_delayed',
      serviceId: 'openai-codex',
      sourceProviderAccountId: 'acct_old_generation',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
    })?.recordKey.accountSubjectId).toBe('acct_old_generation');
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBeNull();
    expect(notifyAccountUsageChanged).not.toHaveBeenCalled();
  });

  it('rebinds an exact current-credential account observation to authoritative current group generation', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const verifyCredentialFingerprint = vi.fn(async () => true);
    const resolveCurrentGroupGenerationForProfile = vi.fn(async () => 8);
    const snapshot = createSnapshot({
      activeAccountId: 'acct_current_credential',
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 10,
        limit: 100,
        unit: 'requests',
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_surviving_runner',
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
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint,
      resolveCurrentGroupGenerationForProfile,
      groupId: 'main',
      groupGeneration: 7,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_surviving_runner',
      serviceId: 'openai-codex',
      sourceProviderAccountId: 'acct_current_credential',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(resolveCurrentGroupGenerationForProfile).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    });
    const currentSource = {
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      bindingKind: 'group_member' as const,
      groupId: 'main',
      groupGeneration: 8,
    };
    const recorded = accountUsage.store.resolveBySource(currentSource);
    expect(recorded?.recordKey.accountSubjectId).toBe('acct_current_credential');
    expect(notifyAccountUsageChanged).toHaveBeenCalledWith({
      sessionId: 'sess_surviving_runner',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      groupGeneration: 8,
      recordId: recorded?.recordId,
      snapshot: recorded,
      source: 'in_band',
    });
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
  });

  it('attributes shared-auth quota evidence to the live provider-qualified group member', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const notifyAccountUsageChanged = vi.fn(async () => {});
    const verifyCredentialFingerprint = vi.fn(async () => true);
    const snapshot = createSnapshot({
      serviceId: 'claude-subscription',
      providerId: 'claude',
      profileId: 'stale-launch-profile',
      activeAccountId: 'claude-live-account',
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_shared_auth',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'group',
                profileId: 'stale-launch-profile',
                groupId: 'claude',
              },
            },
          },
          environmentVariables: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'claude',
              activeProfileId: 'stale-launch-profile',
              fallbackProfileId: 'backup',
              generation: 7,
            }]),
          },
        },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint,
      resolveProviderQualifiedGroupSource: async () => ({
        profileId: 'live-profile',
        groupGeneration: 9,
      }),
      resolveCurrentGroupGenerationForProfile: async () => 9,
      groupId: 'claude',
      groupGeneration: 7,
      notifyAccountUsageChanged,
      runtimeQuotaSnapshots,
      sessionId: 'sess_shared_auth',
      serviceId: 'claude-subscription',
      sourceProviderAccountId: 'claude-live-account',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(verifyCredentialFingerprint).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'live-profile',
      providerAccountId: 'claude-live-account',
    }));
    expect(accountUsage.store.resolveBySource({
      serviceId: 'claude-subscription',
      profileId: 'live-profile',
      bindingKind: 'group_member',
      groupId: 'claude',
      groupGeneration: 9,
    })?.recordKey.accountSubjectId).toBe('claude-live-account');
    expect(notifyAccountUsageChanged).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'live-profile',
      groupId: 'claude',
      groupGeneration: 9,
    }));
  });

  it('records runtime projection and quota proof against current live generation after hot apply', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const recordQuotaProbeFreshProof = vi.fn(async () => {});
    const snapshot = createSnapshot({
      activeAccountId: 'acct_current_credential',
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 10,
        limit: 100,
        unit: 'requests',
        utilizationPct: 10,
        remainingPct: 90,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_hot_applied',
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
          // Immutable launch metadata is intentionally one generation behind.
          environmentVariables: currentGroupEnv('primary'),
        },
      }],
      runtimeQuotaSnapshots,
      sessionId: 'sess_hot_applied',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 8,
      sourceProviderAccountId: 'acct_current_credential',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      resolveCurrentGroupGenerationForProfile: async () => 8,
      resolveExpectedQuotaProbeAppliedIdentity: async () => ({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 8,
        providerAccountId: 'acct_current_credential',
        materialFingerprint: 'sha256:abcdef12',
      }),
      resolveQuotaProbeFreshProof: (proofInput) => resolveQuotaProbeFreshProof({
        ...proofInput,
        nowMs: 2_000,
        maxAgeMs: 30_000,
      }),
      recordQuotaProbeFreshProof,
      snapshot,
    })).resolves.toMatchObject({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
    });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
    await vi.waitFor(() => expect(recordQuotaProbeFreshProof).toHaveBeenCalledWith({
      sessionId: 'sess_hot_applied',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      proofKind: 'quota_probe_fresh',
      observedAtMs: snapshot.fetchedAt,
    }));
  });

  it('records current-generation connected observations without legacy side-effect dependencies', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

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
      runtimeQuotaSnapshots,
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      snapshot: createExhaustedSnapshot(),
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(accountUsage.store.listSnapshots()).toHaveLength(1);
    expect(accountUsage.persistence?.recordInBandSnapshot).toHaveBeenCalledOnce();
  });

  it('merges native and connected aliases only with stable provider-subject evidence', async () => {
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
      runtimeQuotaSnapshots,
      sessionId: 'sess_connected',
      serviceId: 'openai-codex',
      sourceProviderAccountId: 'acct_shared_stable',
      credentialFingerprint: 'sha256:abcdef12',
      verifyCredentialFingerprint: async () => true,
      snapshot: createSnapshot({ activeAccountId: 'acct_shared_stable' }),
    });

    expect(accountUsage.store.listSnapshots()).toHaveLength(1);
    const stableRecordId = accountUsage.store.listSnapshots()[0]?.recordId;
    expect(accountUsage.store.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'primary',
      bindingKind: 'group_member',
      groupId: 'main',
    })?.recordId).toBe(stableRecordId);
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

  it('rejects snapshots whose embedded service id does not match the reported service id', async () => {
    const accountUsage = createAccountUsageHarness();
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = createSnapshot({
      serviceId: 'claude-subscription',
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
      providerId: 'claude',
      activeAccountId: 'acct_claude',
    });

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: { directory: '/tmp/project' },
      }],
      accountUsageRecorder: accountUsage.accountUsageRecorder,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'service_id_mismatch' });

    expect(accountUsage.store.listSnapshots()).toHaveLength(0);
  });
});
