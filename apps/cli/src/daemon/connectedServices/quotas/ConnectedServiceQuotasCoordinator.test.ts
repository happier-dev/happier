import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  buildConnectedServiceCredentialRecord,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceAuthGroupV1,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageRecordKeyV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from '../descriptors/connectedAccountDescriptors';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { RuntimeAccountIdentityProbeResult } from './identity/runtimeAccountIdentityTypes';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from './types';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

type AccountExhaustionInput = Parameters<ConnectedServiceQuotasCoordinator['recordAccountExhaustionAndFanout']>[0];
type RuntimeUsageLimitInput = Parameters<ConnectedServiceQuotasCoordinator['recordRuntimeUsageLimitExhaustionAndFanout']>[0];

function hardLimitCommittedGenerationForTest(input: Readonly<{
  serviceId: AccountExhaustionInput['serviceId'];
  groupId: string;
}>) {
  return buildConnectedServiceAuthGroupCommittedGenerationFact({
    decisionId: `test-hard-limit\0${input.serviceId}\0${input.groupId}`,
    provenance: 'hard_limit',
    decisionCommittedTarget: {
      serviceId: input.serviceId,
      groupId: input.groupId,
      profileId: 'backup',
      generation: 2,
    },
  });
}

function recordAccountExhaustionAndFanoutForTest(
  coordinator: ConnectedServiceQuotasCoordinator,
  input: AccountExhaustionInput,
) {
  const owner = coordinator;
  return owner.recordAccountExhaustionAndFanout({
    ...input,
    committedGeneration: input.committedGeneration ?? hardLimitCommittedGenerationForTest(input),
  });
}

function recordRuntimeUsageLimitExhaustionAndFanoutForTest(
  coordinator: ConnectedServiceQuotasCoordinator,
  input: RuntimeUsageLimitInput,
) {
  const owner = coordinator;
  return owner.recordRuntimeUsageLimitExhaustionAndFanout({
    ...input,
    committedGeneration: input.committedGeneration ?? hardLimitCommittedGenerationForTest(input),
  });
}

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
type ProviderUsageRegisterArgs = Parameters<NonNullable<QuotaApi['registerProviderAccountUsageSnapshotSealed']>>[0];
type ProviderUsageRegisterPlainArgs = Parameters<NonNullable<QuotaApi['registerProviderAccountUsageSnapshotPlain']>>[0];
type FetchArgs = Parameters<ConnectedServiceQuotaFetcher['fetch']>[0];
type SealedCredentialResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceCredentialSealed']>>>;
type SealedQuotaSnapshotResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>>;

const directLiveExternalTokenInjectionCapability = {
  directLiveHotAuth: {
    supportsInTurnApply: true,
    requiresExactRuntimeIdentity: true,
    refreshSelectionResync: 'required',
    authMode: {
      kind: 'external_token_injection',
      surface: 'codex_chatgpt_auth_tokens',
    },
  },
} as const;

const brokerSelectionIndirectionCapability = {
  directLiveHotAuth: {
    supportsInTurnApply: false,
    requiresExactRuntimeIdentity: false,
    refreshSelectionResync: 'not_applicable',
    authMode: {
      kind: 'provider_owned',
      name: 'broker_selection_indirection',
    },
  },
} as const;

function buildQuotaSnapshotFixture(input: Readonly<{
  serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
  profileId: string;
  now: number;
  remainingPct: number;
  resetsAt?: number;
}>): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: input.serviceId,
    profileId: input.profileId,
    fetchedAt: input.now,
    staleAfterMs: 300_000,
    planLabel: 'Pro',
    accountLabel: `${input.profileId}@example.com`,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: Math.max(0, Math.min(100, 100 - input.remainingPct)),
      remainingPct: input.remainingPct,
      resetsAt: input.resetsAt ?? input.now + 600_000,
      status: 'ok',
      details: {},
    }],
  };
}

function buildProviderAccountUsageSnapshotFixture(input: Readonly<{
  serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
  groupId: string;
  profileId: string;
  groupGeneration?: number;
  now: number;
  remainingPct: number;
  resetsAt?: number | null;
}>): ProviderAccountUsageSnapshotV1 {
  const accountSubjectId = `acct_${input.profileId}`;
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: input.now,
    fetchedAtMs: input.now,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: `${input.profileId}@example.com`,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100 - input.remainingPct,
      remainingPct: input.remainingPct,
      resetsAt: input.resetsAt ?? null,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

function recordGroupMemberAccountUsageFixture(
  store: ReturnType<typeof createProviderAccountUsageStore>,
  input: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
    groupId: string;
    profileId: string;
    groupGeneration?: number;
  }>,
): void {
  store.recordSnapshot(input.snapshot, {
    sources: [{
      serviceId: input.serviceId,
      profileId: input.profileId,
      bindingKind: 'group_member',
      groupId: input.groupId,
      ...(input.groupGeneration === undefined ? {} : { groupGeneration: input.groupGeneration }),
    }],
  });
}

function createSoftSwitchEligibilityFixture(input: Readonly<{
  serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
  now: number;
  groupId?: string;
  activeProfileId?: string;
  memberProfileIds?: readonly string[];
  targetProfileIds?: readonly string[];
}>): Readonly<{
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  accountUsageStore: ReturnType<typeof createProviderAccountUsageStore>;
  getConnectedServiceAuthGroup: QuotaApi['getConnectedServiceAuthGroup'];
}> {
  const groupId = input.groupId ?? 'team';
  const activeProfileId = input.activeProfileId ?? 'active';
  const targetProfileIds = input.targetProfileIds ?? ['backup'];
  const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const accountUsageStore = createProviderAccountUsageStore();
  for (const profileId of targetProfileIds) {
    const snapshot = buildQuotaSnapshotFixture({
      serviceId: input.serviceId,
      profileId,
      now: input.now,
      remainingPct: 90,
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: input.serviceId,
      groupId,
      profileId,
      snapshot,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: input.serviceId,
        groupId,
        profileId,
        groupGeneration: 1,
        now: input.now,
        remainingPct: 90,
      }),
      serviceId: input.serviceId,
      groupId,
      profileId,
      groupGeneration: 1,
    });
  }
  const profileIds = Array.from(new Set([activeProfileId, ...(input.memberProfileIds ?? []), ...targetProfileIds]));
  const group: ConnectedServiceAuthGroupV1 = {
    v: 1,
    serviceId: input.serviceId,
    groupId,
    displayName: 'Team',
    activeProfileId,
    generation: 1,
    runtimeStateRevision: 0,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      strategy: 'least_limited',
      cooldownMs: 500,
      softSwitchRemainingPercent: 15,
    },
    state: { v: 1 },
    members: profileIds.map((profileId, index) => ({
      v: 1 as const,
      serviceId: input.serviceId,
      groupId,
      profileId,
      priority: index,
      enabled: true,
      state: {},
      createdAt: index + 1,
      updatedAt: index + 1,
    })),
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    runtimeQuotaSnapshots,
    accountUsageStore,
    getConnectedServiceAuthGroup: vi.fn(async () => group),
  };
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('ConnectedServiceQuotasCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    invalidateConnectedServiceAccountMode();
  });

  it('skips quota bridge fetches for known reconnect-required profiles', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('Reconnect-required profile should not read credentials for quota fetch');
      }),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('fetches and uploads plaintext provider-account usage snapshots for plaintext accounts', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialPlain).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('consumes recovery credits through the quota fetcher and persists a refreshed plaintext snapshot', async () => {
    let now = 1_000_000;
    const accountUsageStore = createProviderAccountUsageStore();
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => 'consumed' as const),
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 0,
          totalCount: 1,
          source: 'provider_api',
          confidence: 'exact',
          credits: [],
        },
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      accountUsageStore,
      accountUsagePersistence,
    });

    const result = await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'reset-req-1',
      providerCreditId: 'credit-1',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      receipt: {
        idempotencyKey: 'reset-req-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
    }));
    expect(fetcher.consumeRecoveryCredit).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        oauth: expect.objectContaining({ accessToken: 'access' }),
      }),
      now,
      idempotencyKey: 'reset-req-1',
      providerCreditId: 'credit-1',
    }));
    const consumeRecoveryCredit = fetcher.consumeRecoveryCredit;
    expect(consumeRecoveryCredit).toBeTypeOf('function');
    if (!consumeRecoveryCredit) {
      throw new Error('expected recovery credit consumer to exist');
    }
    const [consumeRecoveryCreditCall] = vi.mocked(consumeRecoveryCredit).mock.calls;
    expect(consumeRecoveryCreditCall).toBeDefined();
    if (!consumeRecoveryCreditCall) {
      throw new Error('expected recovery credit consumer to be called');
    }
    const consumeRecoveryCreditInput = consumeRecoveryCreditCall[0];
    expect(consumeRecoveryCreditInput).toBeDefined();
    if (!consumeRecoveryCreditInput) {
      throw new Error('expected recovery credit consumer input to exist');
    }
    const consumedRecord = consumeRecoveryCreditInput.record;
    expect(consumedRecord?.kind).toBe('oauth');
    if (consumedRecord?.kind === 'oauth') {
      expect(consumedRecord.oauth).not.toHaveProperty('refreshToken');
    }
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(accountUsagePersistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      recoveryCredits: expect.objectContaining({ availableCount: 0 }),
    }), {
      sources: [
        {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'profile',
        },
      ],
    });
  });

  it.each([
    ['consumed', 'consumed'],
    ['already_consumed', 'already_consumed'],
    ['not_available', 'not_available'],
    ['nothing_to_reset', 'nothing_to_reset'],
  ] as const)('preserves the %s provider-neutral recovery-credit outcome in the RPC receipt', async (providerOutcome, expectedStatus) => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null,
        tokenType: null, providerAccountId: 'acct', providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => providerOutcome),
      fetch: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex', profileId: 'work', idempotencyKey: `req-${providerOutcome}`,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      receipt: { idempotencyKey: `req-${providerOutcome}`, status: expectedStatus },
    }));
  });

  it('fails closed when a quota fetcher returns no recovery-credit outcome', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => undefined),
      fetch: vi.fn(async () => null),
    } as unknown as ConnectedServiceQuotaFetcher;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [fetcher], now: () => now, randomBytes: (length: number) => randomBytes(length),
    });

    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex', profileId: 'work', idempotencyKey: 'req-void',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'connected_service_quota_recovery_credit_invalid_outcome',
    }));
  });

  it('does not refresh near-expiry OAuth credentials before recovery credit consumption', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const freshRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: staleRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({ record: freshRecord, reauthRequired: false }));
    let observedAccessToken: string | null = null;
    let observedRefreshTokenVisible = true;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async ({ record: inputRecord }) => {
        observedAccessToken = inputRecord.kind === 'oauth' ? inputRecord.oauth.accessToken : null;
        observedRefreshTokenVisible = inputRecord.kind === 'oauth' && 'refreshToken' in inputRecord.oauth;
        return 'consumed' as const;
      }),
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });

    await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'reset-no-refresh',
    });

    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(observedAccessToken).toBe('stale-access');
    expect(observedRefreshTokenVisible).toBe(false);
  });

  it('does not refresh or retry recovery credit consumption after a provider auth failure', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const freshRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: staleRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({ record: freshRecord, reauthRequired: false }));
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError('provider auth failed', {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
      fetch: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });

    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'reset-auth-failure',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'auth_failure',
    }));

    expect(fetcher.consumeRecoveryCredit).toHaveBeenCalledTimes(1);
    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('returns the same unknown timeout receipt without a second provider consume for the same idempotency key', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => await new Promise<never>(() => {})),
      fetch: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      fetchTimeoutMs: 5,
    });

    const first = coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'reset-req-timeout',
      providerCreditId: 'credit-1',
    });
    await vi.advanceTimersByTimeAsync(5);

    await expect(first).resolves.toEqual({
      ok: false,
      errorCode: 'connected_service_quota_recovery_credit_timeout',
      error: 'connected_service_quota_recovery_credit_timeout',
      receipt: {
        idempotencyKey: 'reset-req-timeout',
        providerCreditId: 'credit-1',
        status: 'unknown_after_timeout',
      },
    });

    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'reset-req-timeout',
      providerCreditId: 'credit-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'connected_service_quota_recovery_credit_timeout',
      error: 'connected_service_quota_recovery_credit_timeout',
      receipt: {
        idempotencyKey: 'reset-req-timeout',
        providerCreditId: 'credit-1',
        status: 'unknown_after_timeout',
      },
    });
    expect(fetcher.consumeRecoveryCredit).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('keeps stale useful quota data when a disabled fetcher returns quota_unknown', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const staleUsefulSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'claude-subscription',
      profileId: 'work',
      fetchedAt: now - 600_000,
      staleAfterMs: 1_000,
      planLabel: 'Max',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'five_hour',
          label: '5-hour',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 80,
          resetsAt: now + 120_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const disabledUnknownSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      ...staleUsefulSnapshot,
      fetchedAt: now,
      planLabel: null,
      meters: [
        {
          meterId: 'five_hour',
          label: '5-hour',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: null,
          resetsAt: null,
          status: 'unavailable',
          details: { code: 'quota_unknown' },
        },
      ],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: staleUsefulSnapshot },
        metadata: {
          fetchedAt: staleUsefulSnapshot.fetchedAt,
          staleAfterMs: staleUsefulSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => disabledUnknownSnapshot),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      runtimeQuotaSnapshots,
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    const runtimeSnapshot = runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'work-group',
      profileId: 'work',
    });
    expect(runtimeSnapshot?.accountLabel).toBe('user@example.com');
    expect(runtimeSnapshot?.meters[0]?.utilizationPct).toBe(80);
    expect(runtimeSnapshot?.meters[0]?.details?.code).toBe('stale_quota');
  });

  it('isolates provider fetch failures so one provider does not break another usage display update', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const claudeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: 'claude@example.com',
      },
    });
    const codexRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'codex-work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'codex-acct',
        providerEmail: 'codex@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ serviceId, profileId }: { serviceId: string; profileId: string }) => {
        if (serviceId === 'claude-subscription' && profileId === 'claude-work') {
          return { content: { t: 'plain' as const, v: claudeRecord } };
        }
        if (serviceId === 'openai-codex' && profileId === 'codex-work') {
          return { content: { t: 'plain' as const, v: codexRecord } };
        }
        return null;
      }),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const failingFetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError('claude quota fetch failed', {
          quotaFetchErrorCode: 'network',
          status: null,
          retryAfterMs: null,
        });
      }),
    };
    const healthyFetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildQuotaSnapshotFixture({
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        now,
        remainingPct: 64,
      })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [failingFetcher, healthyFetcher],
      runtimeQuotaSnapshots,
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-work' } },
      },
    });
    coordinator.registerSpawnTarget({
      pid: 456,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'codex-work' } },
      },
    });

    await coordinator.tickOnce();

    expect(failingFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(healthyFetcher.fetch).toHaveBeenCalledTimes(1);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      recordId: expect.any(String),
      content: {
        t: 'plain',
        v: expect.objectContaining({
          providerId: 'openai-codex',
          accountLabel: 'codex-work@example.com',
          meters: [expect.objectContaining({ remainingPct: 64 })],
        }),
      },
      metadata: expect.objectContaining({ status: 'ok' }),
    }));
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'codex-work-group',
      profileId: 'codex-work',
    })).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'codex-work',
      accountLabel: 'codex-work@example.com',
    }));
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'claude-work-group',
      profileId: 'claude-work',
    })).toBeNull();
  });

  it('records fetched quota snapshots under the credential provider account when the provider omits active account id', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: null,
        providerAccountId: 'claude-provider-account',
        providerEmail: 'claude@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildQuotaSnapshotFixture({
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        now,
        remainingPct: 72,
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 789,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      content: {
        t: 'plain',
        v: expect.objectContaining({
          providerId: 'claude-subscription',
          accountSubject: { kind: 'providerSubject', id: 'claude-provider-account' },
          recordKey: expect.objectContaining({
            accountSubjectId: 'claude-provider-account',
            subjectKind: 'account',
          }),
        }),
      },
      source: {
        serviceId: 'claude-subscription',
        profileId: 'claude-work',
        bindingKind: 'profile',
      },
    }));
  });

  it('routes polling quota snapshot writes through daemon server work', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async (request) => {
        await request.run(request.payload);
        return { status: 'written' as const };
      }),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['quotaPersistenceServerWorkScheduler']>;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceServerWorkScheduler: serverWorkScheduler,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(serverWorkScheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      key: expect.stringContaining('openai-codex'),
    }));
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('defers polling quota work when the account-mode probe errors', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalled();
    expect((api as any).getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('fetches and uploads sealed quota snapshots for active bindings', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedCiphertext: string | null = null;
    let uploadedStatus: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: ProviderUsageRegisterArgs) => {
        uploadedCiphertext = params.sealed.ciphertext;
        uploadedStatus = params.metadata?.status ?? null;
      }),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: 1,
            limit: 10,
            unit: 'count',
            utilizationPct: 10,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith(expect.objectContaining({
      recordId: expect.any(String),
      sealed: expect.objectContaining({
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      }),
      metadata: expect.objectContaining({
        fetchedAt: now,
        staleAfterMs: 300_000,
        status: 'ok',
      }),
    }));
    expect(typeof uploadedCiphertext).toBe('string');
    expect(uploadedStatus).toBe('ok');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'provider_account_usage_snapshot',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: uploadedCiphertext ?? '',
    });
    expect(opened?.value).toBeTruthy();
    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(opened?.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.providerId).toBe('openai-codex');
      expect(parsed.data.accountLabel).toBe('user@example.com');
    }
  });

  it('does not source-link provider-account usage when the fetched provider account differs from the credential profile', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-connected-profile',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };
    const registerProviderAccountUsageSnapshotSealed = vi.fn(async (_params: ProviderUsageRegisterArgs) => {});
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed,
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        providerId: 'codex',
        activeAccountId: 'acct-observed-provider',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'other@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    const uploaded = registerProviderAccountUsageSnapshotSealed.mock.calls[0]?.[0];
    expect(uploaded).toBeDefined();
    expect(uploaded?.recordKey.accountSubjectId).toBe('acct-observed-provider');
    expect(uploaded?.source).toBeUndefined();
  });

  it('uses resolved group active profiles from child selections when registering spawn targets', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'work',
          fallbackProfileId: 'fallback',
          generation: 7,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    }));
  });

  it('prefers the active group selection over the fallback binding profile after switches', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'live',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const activeCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: activeRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async ({ profileId }: { profileId: string }) => profileId === 'live'
        ? {
            sealed: { format: 'account_scoped_v1' as const, ciphertext: activeCiphertext },
            metadata: { kind: 'oauth' as const },
          }
        : null),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
            profileId: 'fallback',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'live',
          fallbackProfileId: 'fallback',
          generation: 8,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'live',
    });
    expect(fetcher.fetch).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'live',
      }),
    }));
  });

  it('asks the auth-group switch coordinator to re-evaluate an active group after refreshing its active profile quota', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const diagnostics: unknown[] = [];
    const coordinatorParams = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    };
    const coordinator = new ConnectedServiceQuotasCoordinator(coordinatorParams);

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });
    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_requested',
      phase: 'soft_switch',
      reason: 'soft_switch_requested',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'active',
      eligibilityStatus: 'eligible',
      sourceProfileId: 'active',
      sourceRemainingPercent: 5,
      sourceThresholdPercent: 15,
      // PS-1: reactive at-threshold switch — the source was observed below threshold, not projected.
      sourceProjected: false,
      targetCount: 1,
      allowedTargetCount: 1,
    }));
  });

  it('uses canonical group truth when an in-band sibling still reports a predecessor profile', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
      memberProfileIds: ['stale-predecessor'],
    });
    recordGroupMemberAccountUsageFixture(softSwitchEligibility.accountUsageStore, {
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'active',
        groupGeneration: 1,
        now,
        remainingPct: 5,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
    });
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'stale-sibling',
      serviceId: 'openai-codex',
      profileId: 'stale-predecessor',
      groupId: 'team',
      groupGeneration: 1,
      recordId: 'pau_stale',
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'stale-predecessor',
        groupGeneration: 1,
        now,
        remainingPct: 90,
      }),
      source: 'in_band',
    });

    expect(switchBeforeTurn).toHaveBeenCalledOnce();
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'stale-sibling',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('delegates no-eligible-member decisions to the authoritative coordinator', async () => {
    let now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const memberStates = new Map<string, Record<string, unknown>>([
      ['active', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 1_000,
        providerResetsAtMs: resetAtMs,
      }],
      ['backup', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 1_000,
        providerResetsAtMs: resetAtMs,
      }],
    ]);
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'active',
      generation: 1,
      policy: {
        v: 1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['active', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: memberStates.get(profileId) ?? {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: resetAtMs,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      accountUsageStore,
      runtimeQuotaSnapshots,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);

    now = resetAtMs - 1;
    memberStates.set('backup', {});
    await coordinator.tickOnce();
    expect(switchBeforeTurn).toHaveBeenCalledTimes(2);

    now = resetAtMs + 1;
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 10,
            remainingPct: 90,
            resetsAt: now + 600_000,
            status: 'ok',
            details: {},
          },
        ],
      },
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 90,
        resetsAt: now + 600_000,
      }),
    });
    await coordinator.tickOnce();
    expect(switchBeforeTurn).toHaveBeenCalledTimes(3);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('delegates candidate quality to the authoritative coordinator after quota evidence trips', async () => {
    let now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 90,
          remainingPct: 10,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      },
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 10,
        resetsAt: resetAtMs,
      }),
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'active',
      generation: 1,
      policy: {
        v: 1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
        softSwitchRemainingPercent: 15,
      },
      state: { v: 1 },
      members: ['active', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      accountUsageStore,
      runtimeQuotaSnapshots,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(recordDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({
      reason: 'soft_switch_no_meaningfully_better_target',
    }));

    now = resetAtMs + 1;
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 10,
          remainingPct: 90,
          resetsAt: now + 600_000,
          status: 'ok',
          details: {},
        }],
      },
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 90,
        resetsAt: now + 600_000,
      }),
    });
    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(2);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('suppresses proactive soft-threshold switching when the active profile remains above the threshold', async () => {
    const now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 25,
          remainingPct: 75,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      },
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 75,
        resetsAt: resetAtMs,
      }),
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'active',
      generation: 1,
      policy: {
        v: 1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
        softSwitchRemainingPercent: 15,
      },
      state: { v: 1 },
      members: ['active', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 48,
          remainingPct: 52,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      accountUsageStore,
      runtimeQuotaSnapshots,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_no_meaningfully_better_target',
    }));
  });

  it('suppresses proactive soft-threshold switching when stale active-profile state hides fresh healthy quota', async () => {
    const now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 25,
          remainingPct: 75,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      },
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 75,
        resetsAt: resetAtMs,
      }),
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'active',
      generation: 1,
      policy: {
        v: 1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
        softSwitchRemainingPercent: 15,
      },
      state: { v: 1 },
      members: ['active', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: profileId === 'active'
          ? {
              cooldownUntilMs: now + 30_000,
              cooldownStartedAtMs: now - 1_000,
            }
          : {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 48,
          remainingPct: 52,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      accountUsageStore,
      runtimeQuotaSnapshots,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_no_meaningfully_better_target',
    }));
  });

  it('suppresses proactive soft-threshold switching when target eligibility cannot be resolved', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => {
        throw new Error('timeout of 5000ms exceeded');
      }),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(api.getConnectedServiceAuthGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'team',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_target_eligibility_unknown',
    }));
  });

  it('suppresses proactive soft-threshold switching when runtime quota evidence is unhydrated', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_target_eligibility_unknown',
    }));
  });

  it('does not use stale legacy target snapshots before delegating selection to the coordinator', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: createProviderAccountUsageStore(),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledOnce();
  });

  it('reactively soft-switches on an in-band usage change when the active member is projected to burn below the threshold before the next window', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    // Fast burn on the ACTIVE member: 60% -> 40% remaining across 30s in the in-band runtime store.
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex', profileId: 'active', now: now - 30_000, remainingPct: 60, resetsAt: now + 600_000,
      }),
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex', profileId: 'active', now, remainingPct: 40, resetsAt: now + 600_000,
      }),
    });

    // Canonical source-backed account usage: active is at 40% (ABOVE the 15% threshold — a poll-only
    // soft-switch would not fire), backup is healthy at 90%.
    const accountUsageStore = createProviderAccountUsageStore();
    const activeUsageSnapshot = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1, now, remainingPct: 40,
      resetsAt: now + 600_000,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: activeUsageSnapshot, serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex', groupId: 'team', profileId: 'backup', groupGeneration: 1, now, remainingPct: 90,
      }),
      serviceId: 'openai-codex', groupId: 'team', profileId: 'backup', groupGeneration: 1,
    });

    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: { getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup } as unknown as QuotaApi,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'active',
      groupId: 'team',
      groupGeneration: 1,
      recordId: activeUsageSnapshot.recordId,
      snapshot: activeUsageSnapshot,
      source: 'in_band',
    });

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    }));
    // PS-1: a burn-projection switch must be distinguishable from a reactive one in diagnostics —
    // the source was ABOVE threshold (40% vs 15%) and only the projected next-window remaining tripped it.
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_requested',
      phase: 'soft_switch',
      eligibilityStatus: 'eligible',
      sourceProjected: true,
    }));
  });

  it('does not combine a newer replenished canonical snapshot with an older in-band burn projection', async () => {
    const burnObservedAt = 1_000_000;
    const canonicalObservedAt = burnObservedAt + 1;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now: canonicalObservedAt,
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex',
        profileId: 'active',
        now: burnObservedAt - 30_000,
        remainingPct: 60,
        resetsAt: burnObservedAt + 600_000,
      }),
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex',
        profileId: 'active',
        now: burnObservedAt,
        remainingPct: 40,
        resetsAt: burnObservedAt + 600_000,
      }),
    });

    const replenishedUsage = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      now: canonicalObservedAt,
      remainingPct: 100,
      resetsAt: burnObservedAt + 600_000,
    });
    recordGroupMemberAccountUsageFixture(softSwitchEligibility.accountUsageStore, {
      snapshot: replenishedUsage,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
    });

    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: { getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup } as unknown as QuotaApi,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [],
      now: () => canonicalObservedAt,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'active',
      groupId: 'team',
      groupGeneration: 1,
      recordId: replenishedUsage.recordId,
      snapshot: replenishedUsage,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('does not reactively soft-switch evidence-only or poll-sourced usage changes', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({ serviceId: 'openai-codex', now });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active',
      snapshot: buildQuotaSnapshotFixture({ serviceId: 'openai-codex', profileId: 'active', now: now - 30_000, remainingPct: 60 }),
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active',
      snapshot: buildQuotaSnapshotFixture({ serviceId: 'openai-codex', profileId: 'active', now, remainingPct: 40 }),
    });
    const accountUsageStore = createProviderAccountUsageStore();
    const activeUsageSnapshot = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1, now, remainingPct: 40,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: activeUsageSnapshot, serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1,
    });
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: { getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup } as unknown as QuotaApi,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    });

    // An omitted or future source classification cannot inherit predictive switching authority.
    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'active',
      groupId: 'team',
      groupGeneration: 1,
      recordId: activeUsageSnapshot.recordId,
      snapshot: activeUsageSnapshot,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'active',
      groupId: 'team',
      groupGeneration: 1,
      recordId: activeUsageSnapshot.recordId,
      snapshot: activeUsageSnapshot,
      source: 'evidence_only',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'post_hard_limit_snapshot_evidence_only',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'active',
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'active',
      groupId: 'team',
      groupGeneration: 1,
      recordId: activeUsageSnapshot.recordId,
      snapshot: activeUsageSnapshot,
      source: 'poll',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('records polling snapshots as canonical account usage before evaluating proactive switching', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const accountUsageStore = createProviderAccountUsageStore();
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const buildRecord = (profileId: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId,
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: `${profileId}-access`,
        refreshToken: `${profileId}-refresh`,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: `acct-${profileId}`,
        providerEmail: `${profileId}@example.com`,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'active', status: 'connected' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: buildRecord(profileId) },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: `${inputRecord.profileId}@example.com`,
        activeAccountId: `acct-${inputRecord.profileId}`,
        confidence: 'exact',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: inputRecord.profileId === 'active' ? 95 : 10,
          remainingPct: inputRecord.profileId === 'active' ? 5 : 90,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: true,
      discoveryIntervalMs: 1,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore,
      accountUsagePersistence,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'active',
      bindingKind: 'profile',
    })).toEqual(expect.objectContaining({
      accountLabel: 'active@example.com',
    }));
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'profile',
    })).toEqual(expect.objectContaining({
      accountLabel: 'backup@example.com',
    }));
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 1,
    })).toEqual(expect.objectContaining({
      accountLabel: 'backup@example.com',
    }));
    expect(accountUsagePersistence.recordInBandSnapshot).toHaveBeenCalled();
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('drives proactive switching from fresh canonical account-usage projections without legacy runtime quota snapshots', async () => {
    const now = 1_000_000;
    const accountUsageStore = createProviderAccountUsageStore();
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'active',
        groupGeneration: 1,
        now,
        remainingPct: 5,
        resetsAt: now + 60_000,
      }),
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 90,
        resetsAt: now + 600_000,
      }),
    });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('leaves generation-qualified target evidence evaluation to the authoritative coordinator', async () => {
    const now = 1_000_000;
    const accountUsageStore = createProviderAccountUsageStore();
    accountUsageStore.recordSnapshot(buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      now,
      remainingPct: 90,
      resetsAt: now + 600_000,
    }));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        activeAccountId: 'acct-active',
        confidence: 'exact',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledOnce();
  });

  it('does not require per-session recovery permission for the canonical proactive group switch', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledOnce();
    expect(recordDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
    }));
  });

  it('uses the canonical reported session id for proactive soft-threshold policy guards', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'claude-subscription',
      now,
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'monthly',
            label: 'Monthly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const softSwitchPolicyGuard = vi.fn(async () => ({
      status: 'suppress' as const,
      reason: 'predictive_soft_switch_restart_required',
    }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      softSwitchPolicyGuard,
      recordDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'spawn-request-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });
    coordinator.updateSpawnTargetSessionId({
      pid: 123,
      sessionId: 'canonical-session-1',
    });

    await coordinator.tickOnce();

    expect(softSwitchPolicyGuard).toHaveBeenCalledWith({
      sessionId: 'canonical-session-1',
      serviceId: 'claude-subscription',
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'predictive_soft_switch_restart_required',
    });
  });

  it('keeps proactive soft-threshold switching active without per-session recovery permission', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('deduplicates proactive soft-threshold quota fetches while applying to every session sharing the same group and active profile', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => buildQuotaSnapshotFixture({
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        now,
        remainingPct: 5,
      })),
    };
    let groupDecisionCount = 0;
    let groupDecisionInFlight = false;
    const switchBeforeTurn = vi.fn(async (_input: Readonly<{
      sessionId?: string;
      serviceId: string;
      groupId: string;
      reason: 'soft_threshold';
    }>) => {
      if (!groupDecisionInFlight) {
        groupDecisionInFlight = true;
        groupDecisionCount++;
        await Promise.resolve();
        groupDecisionInFlight = false;
        return {
          status: 'switched' as const,
          activeProfileId: 'backup',
          generation: 2,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        };
      }
      await Promise.resolve();
      return {
        status: 'observed_generation' as const,
        activeProfileId: 'backup',
        generation: 2,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      };
    });
    const applyCommittedGeneration = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({ outcome: 'adopted_current' as const }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn, applyCommittedGeneration },
      consumeCommittedAuthGroupGeneration,
      groupSwitchCheckMinIntervalMs: 0,
    });

    for (const [pid, sessionId] of [[123, 'session-1'], [456, 'session-2']] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'active',
            fallbackProfileId: 'backup',
            generation: 1,
          }]),
        },
      });
    }

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(groupDecisionCount).toBe(1);
    expect(switchBeforeTurn).toHaveBeenCalledOnce();
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith(expect.objectContaining({
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({
          profileId: 'backup',
          generation: 2,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }),
      }),
      executionAuthority: 'runtime_recovery',
      sessions: [
        expect.objectContaining({ sessionId: 'session-1', activity: 'live' }),
        expect.objectContaining({ sessionId: 'session-2', activity: 'live' }),
      ],
    }));
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('coalesces proactive soft-threshold checks onto canonical truth for one shared group', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const records = new Map(['active-a', 'active-b'].map((profileId) => [profileId, buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId,
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: `${profileId}-access`,
        refreshToken: `${profileId}-refresh`,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: `${profileId}-acct`,
        providerEmail: `${profileId}@example.com`,
      },
    })]));
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
      activeProfileId: 'active-a',
      memberProfileIds: ['active-b'],
      targetProfileIds: ['backup'],
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: records.get(profileId)! },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => buildQuotaSnapshotFixture({
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        now,
        remainingPct: 5,
      })),
    };
    const switchBeforeTurn = vi.fn(async (_input: Readonly<{
      sessionId?: string;
      serviceId: string;
      groupId: string;
      reason: 'soft_threshold';
    }>) => ({ status: 'no_eligible_profile' as const }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    for (const [pid, sessionId, activeProfileId] of [
      [123, 'session-1', 'active-a'],
      [456, 'session-2', 'active-b'],
    ] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId,
            fallbackProfileId: 'backup',
            generation: 1,
          }]),
        },
      });
    }

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(switchBeforeTurn).toHaveBeenCalledOnce();
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active-a',
    });
  });

  it('uses deterministic bounded jitter when scheduling the next proactive soft-threshold check', async () => {
    let now = 1_000_000;

    const accountUsageStore = createProviderAccountUsageStore();
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'active',
        groupGeneration: 1,
        now,
        remainingPct: 5,
        resetsAt: now + 60_000,
      }),
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
      snapshot: buildProviderAccountUsageSnapshotFixture({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        groupGeneration: 1,
        now,
        remainingPct: 90,
        resetsAt: now + 600_000,
      }),
    });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-active',
        providerEmail: 'active@example.com',
      },
    });
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'active@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'no_eligible_profile' as const }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      accountUsageStore,
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(128),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 1_000,
      groupSwitchCheckJitterMs: 500,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();
    now += 1_249;
    await coordinator.tickOnce();
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);

    now += 1;
    await coordinator.tickOnce();
    expect(switchBeforeTurn).toHaveBeenCalledTimes(2);
  });

  it('defers quota probes and proactive switch attempts while the local-server storm gate is closed', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => null),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'no_eligible_profile' as const }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      quotaWorkGate: () => ({ status: 'deferred', reason: 'local_server_storm', retryAfterMs: 2_000 }),
      recordDiagnostic,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(api.getAccountEncryptionMode).not.toHaveBeenCalled();
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith({
      event: 'quota_work_deferred',
      phase: 'tick',
      reason: 'local_server_storm',
      retryAfterMs: 2_000,
    });
  });

  it('keeps active-group soft switching independent from quota persistence failures', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const runtimeQuotaSnapshots = softSwitchEligibility.runtimeQuotaSnapshots;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: activeRecord } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {
        throw new Error('server timeout');
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'active',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => snapshot),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
    })).toBe(snapshot);
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('fails closed after proving siblings when recipient generation apply is unavailable', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (sessionId: string, pid: number) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    };
    registerGroupSession('source', 101);
    registerGroupSession('same-account', 102);
    registerGroupSession('different-account', 103);
    registerGroupSession('unknown-account', 104);

    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'different-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-b',
      accountLabel: null,
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('does not fan out through stale snapshot identity whose active profile no longer matches the group binding', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    for (const [sessionId, pid, activeProfileId, generation] of [
      ['source', 101, 'primary', 4],
      ['stale-same-account', 102, 'runtime-current', 4],
    ] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId,
            fallbackProfileId: 'backup',
            generation,
          }]),
        },
      });
    }

    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'stale-same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('fans out runtime usage-limit reports through the exact source identity index', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    for (const [sessionId, pid] of [['source', 501], ['same-account', 502]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'runtime_quota_snapshot',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      resetAtMs: null,
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
  });

  it('fans out runtime usage-limit reports through the supplied exact source account after the source session already switched', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const readRuntimeAccountIdentity = vi.fn(async (input: {
      sessionId: string;
      serviceId: string;
      groupId: string;
      profileId: string;
      expectedGroupGeneration: number | null;
    }) => {
      if (input.sessionId === 'source') {
        return {
          status: 'verified' as const,
          providerAccountId: 'acct-b',
          accountLabel: 'target@example.test',
          profileId: 'backup',
          groupId: 'team',
          groupGeneration: 4,
          proofStrength: 'exact' as const,
          source: 'runtime_identity_probe' as const,
        };
      }
      return {
        status: 'verified' as const,
        providerAccountId: 'acct-a',
        accountLabel: 'source@example.test',
        profileId: 'primary',
        groupId: 'team',
        groupGeneration: 4,
        proofStrength: 'exact' as const,
        source: 'runtime_identity_probe' as const,
      };
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
    });

    for (const [sessionId, pid] of [['source', 501], ['same-account', 502]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: sessionId === 'source' ? 'backup' : 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: 'source@example.test',
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      resetAtMs: null,
      sourceProviderAccountId: 'acct-a',
      sourceAccountLabel: 'source@example.test',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledTimes(1);
    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
    });
  });

  it('still consumes committed group truth when exact source account identity is unavailable for same-account attribution', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({ outcome: 'adopted_current' as const }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'inexact' as const,
      reason: 'runtime_identity_probe_missing_exact_identity',
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      consumeCommittedAuthGroupGeneration,
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    coordinator.registerSpawnTarget({
      pid: 601,
      sessionId: 'source',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 4,
        }]),
      },
    });

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      resetAtMs: null,
      sourceGroupGeneration: 3,
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 1,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 3,
    });
    // This path already carries the coordinator's immutable committed fact. Missing exact
    // provider-account proof may suppress exhaustion attribution, but it must neither reselect
    // nor prevent the current group generation from reaching the live runtime.
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith(expect.objectContaining({
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({
          profileId: 'backup',
          generation: 2,
        }),
      }),
      sessions: [{ sessionId: 'source', activity: 'live', fromProfileId: 'primary' }],
      executionAuthority: 'runtime_recovery',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_missing_source_provider_account_id',
      sessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      sourceProfileId: 'primary',
      expectedGroupGeneration: 3,
      decisionTrace: expect.objectContaining({
        proofSource: 'runtime_identity_probe',
        sourceSessionId: 'source',
        sourceProfileId: 'primary',
        expectedGroupGeneration: 3,
        proofSourcesTried: [
          'runtime_auth_failure_report',
          'runtime_identity_index',
          'runtime_identity_probe',
        ],
      }),
    }));
  });

  describe('cold-index same-account fanout persisted-identity fallback', () => {
    const buildColdFanoutHarness = (options: Readonly<{
      probe: () => Promise<RuntimeAccountIdentityProbeResult>;
      readPersistedSessionAccountIdentity?: (input: {
        sessionId: string;
        serviceId: string;
        groupId: string;
        profileId: string;
        expectedGroupGeneration: number | null;
      }) => Promise<{
        providerAccountId: string;
        serviceId: 'openai-codex';
        groupId: string | null;
        profileId: string;
        groupGeneration: number | null;
      } | null>;
    }>) => {
      const now = 1_000_000;
      const credentials: Credentials = {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      };
      const api = {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
        getConnectedServiceCredentialPlain: vi.fn(async () => null),
        registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
        registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      } as unknown as QuotaApi;
      const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
      const readRuntimeAccountIdentity = vi.fn(options.probe);
      const readPersistedSessionAccountIdentity = options.readPersistedSessionAccountIdentity
        ? vi.fn(options.readPersistedSessionAccountIdentity)
        : undefined;
      const diagnostics: unknown[] = [];
      const coordinator = new ConnectedServiceQuotasCoordinator({
        api,
        credentials,
        quotaFetchers: [],
        now: () => now,
        randomBytes: (length: number) => randomBytes(length),
        authGroupSwitchCoordinator: { switchBeforeTurn },
        groupSwitchCheckMinIntervalMs: 0,
        sameAccountFanoutStrategyResolver: () => 'provider_account_id',
        readRuntimeAccountIdentity,
        ...(readPersistedSessionAccountIdentity ? { readPersistedSessionAccountIdentity } : {}),
        recordDiagnostic: (event) => diagnostics.push(event),
      });
      // Register source + a COLD sibling (no recordRuntimeAccountIdentityFromSnapshot ⇒ index is cold
      // for the sibling, so it flows through the cold reconcile path — the post-restart scenario).
      for (const [sessionId, pid] of [['source', 701], ['same-account', 702]] as const) {
        coordinator.registerSpawnTarget({
          pid,
          sessionId,
          connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
            },
          },
          connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'team',
              activeProfileId: 'primary',
              fallbackProfileId: 'backup',
              generation: 4,
            }]),
          },
        });
      }
      return { coordinator, switchBeforeTurn, diagnostics, readPersistedSessionAccountIdentity, now };
    };

    it('retains a cold sibling via its persisted materialization identity when the live probe is inexact', async () => {
      const harness = buildColdFanoutHarness({
        probe: async () => ({ status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' }),
        readPersistedSessionAccountIdentity: async () => ({
          providerAccountId: 'acct-a',
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'primary',
          groupGeneration: 4,
        }),
      });

      await expect(recordAccountExhaustionAndFanoutForTest(harness.coordinator, {
        sourceSessionId: 'source',
        serviceId: 'openai-codex',
        groupId: 'team',
        exhaustedProfileId: 'primary',
        providerAccountId: 'acct-a',
        resetAtMs: null,
        reason: 'usage_limit',
      })).resolves.toEqual({ status: 'recorded', fanoutCandidates: 1, fanoutRequests: 0 });
      expect(harness.diagnostics).toContainEqual(expect.objectContaining({
        event: 'quota_work_deferred',
        phase: 'same_account_fanout',
        reason: 'same_account_fanout_retained_via_persisted_materialization_identity',
        decisionTrace: expect.objectContaining({ proofSource: 'persisted_materialization_identity' }),
      }));
    });

    it('still suppresses a cold sibling when the live probe VERIFIES a different account, even if persisted identity matches', async () => {
      const harness = buildColdFanoutHarness({
        probe: async () => ({
          status: 'verified',
          strategy: 'provider_account_id',
          providerAccountId: 'acct-b',
          proofStrength: 'exact',
          source: 'runtime_identity_probe',
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
        }),
        readPersistedSessionAccountIdentity: async () => ({
          providerAccountId: 'acct-a',
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'primary',
          groupGeneration: 4,
        }),
      });

      await expect(recordAccountExhaustionAndFanoutForTest(harness.coordinator, {
        sourceSessionId: 'source',
        serviceId: 'openai-codex',
        groupId: 'team',
        exhaustedProfileId: 'primary',
        providerAccountId: 'acct-a',
        resetAtMs: null,
        reason: 'usage_limit',
      })).resolves.toEqual({ status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 });

      expect(harness.switchBeforeTurn).not.toHaveBeenCalled();
      expect(harness.readPersistedSessionAccountIdentity).not.toHaveBeenCalled();
      expect(harness.diagnostics).toContainEqual(expect.objectContaining({
        reason: 'runtime_identity_probe_account_mismatch',
      }));
    });

    it('suppresses a cold sibling with proofSourcesTried when neither probe nor persisted identity proves the account', async () => {
      const harness = buildColdFanoutHarness({
        probe: async () => ({ status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' }),
        readPersistedSessionAccountIdentity: async () => null,
      });

      await expect(recordAccountExhaustionAndFanoutForTest(harness.coordinator, {
        sourceSessionId: 'source',
        serviceId: 'openai-codex',
        groupId: 'team',
        exhaustedProfileId: 'primary',
        providerAccountId: 'acct-a',
        resetAtMs: null,
        reason: 'usage_limit',
      })).resolves.toEqual({ status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 });

      expect(harness.switchBeforeTurn).not.toHaveBeenCalled();
      expect(harness.readPersistedSessionAccountIdentity).toHaveBeenCalledOnce();
      expect(harness.diagnostics).toContainEqual(expect.objectContaining({
        event: 'quota_work_suppressed',
        reason: 'runtime_identity_probe_missing_exact_identity',
        decisionTrace: expect.objectContaining({
          proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'],
        }),
      }));
    });
  });

  it('applies warmed direct-live-capable same-account siblings immediately when runtime reconciliation reports an active provider turn', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'verified' as const,
      providerAccountId: 'acct-a',
      accountLabel: 'same@example.com',
      proofStrength: 'exact' as const,
      source: 'runtime_identity_probe' as const,
      runtime: {
        inProviderTurn: true,
        safeToApply: false,
      },
    }));
    const diagnostics: unknown[] = [];
    const coordinatorParams = {
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id' as const,
      runtimeAuthApplyCapabilityResolver: (input: Readonly<{
        sourceSessionId: string;
        targetSessionId?: string;
      }>) => input.targetSessionId === 'same-account'
        ? directLiveExternalTokenInjectionCapability
        : { directLiveHotAuth: 'unsupported' },
      readRuntimeAccountIdentity,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      readRuntimeAccountIdentity: typeof readRuntimeAccountIdentity;
    };
    const coordinator = new ConnectedServiceQuotasCoordinator(coordinatorParams);
    for (const [sessionId, pid] of [['source', 491], ['same-account', 492]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledTimes(1);
    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
  });

  it('fans out a broker-indirection (daemon-authoritative) sibling WITHOUT a live probe instead of silently stranding it', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    // The opencode/pi runtime cannot answer the identity probe — a live probe would return the
    // stranding `unsupported_session_runtime_method`. The daemon's indexed identity is authoritative.
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'unsupported_session_runtime_method',
    }));
    const diagnostics: unknown[] = [];
    const coordinatorParams = {
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id' as const,
      runtimeAuthApplyCapabilityResolver: (input: Readonly<{
        sourceSessionId: string;
        targetSessionId?: string;
      }>) => input.targetSessionId === 'same-account'
        ? brokerSelectionIndirectionCapability
        : { directLiveHotAuth: 'unsupported' as const },
      readRuntimeAccountIdentity,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      readRuntimeAccountIdentity: typeof readRuntimeAccountIdentity;
    };
    const coordinator = new ConnectedServiceQuotasCoordinator(coordinatorParams);
    for (const [sessionId, pid] of [['source', 591], ['same-account', 592]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    // The daemon-authoritative candidate is switched (cross-account applied via broker), NOT stranded,
    // and its runtime is never probed for identity.
    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      reason: 'unsupported_session_runtime_method',
    }));
  });

  it('seeds exact runtime account identity from connected-service spawn selection before quota snapshots arrive', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (sessionId: string, pid: number, providerAccountId: string) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          source: 'spawn_selection',
          record: buildConnectedServiceCredentialRecord({
            now,
            serviceId: 'openai-codex',
            profileId: 'primary',
            kind: 'oauth',
            expiresAt: now + 60_000,
            oauth: {
              accessToken: 'access',
              refreshToken: 'refresh',
              idToken: null,
              scope: null,
              tokenType: null,
              providerAccountId,
              providerEmail: `${sessionId}@example.com`,
            },
          }),
        }],
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & {
        runtimeAccountIdentitySelections: ReadonlyArray<unknown>;
      });
    };

    registerGroupSession('source', 501, 'acct-a');
    registerGroupSession('same-account', 502, 'acct-a');
    registerGroupSession('different-account', 503, 'acct-b');

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('seeds exact runtime account identity from direct registry spawn selection writes', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry({ nowMs: () => now });
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      runtimeRegistry,
    });
    const registerGroupSession = (sessionId: string, pid: number, providerAccountId: string) => {
      runtimeRegistry.registerTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          source: 'spawn_selection',
          providerAccountId,
          accountLabel: `${sessionId}@example.com`,
        }],
      });
    };

    registerGroupSession('source', 511, 'acct-a');
    registerGroupSession('same-account', 512, 'acct-a');
    registerGroupSession('different-account', 513, 'acct-b');

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('keeps exact hot-apply runtime identity authoritative when a group session spawn env still names the previous profile', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 6 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (input: Readonly<{
      sessionId: string;
      pid: number;
      runtimeProfileId?: string;
      providerAccountId?: string;
    }>) => {
      coordinator.registerSpawnTarget({
        pid: input.pid,
        sessionId: input.sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'stale-profile',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
        ...(input.runtimeProfileId && input.providerAccountId
          ? {
              runtimeAccountIdentitySelections: [{
                serviceId: 'openai-codex',
                profileId: input.runtimeProfileId,
                groupId: 'team',
                groupGeneration: 4,
                source: 'codex_live_auth_apply',
                record: buildConnectedServiceCredentialRecord({
                  now,
                  serviceId: 'openai-codex',
                  profileId: input.runtimeProfileId,
                  kind: 'oauth',
                  expiresAt: now + 60_000,
                  oauth: {
                    accessToken: 'access',
                    refreshToken: 'refresh',
                    idToken: null,
                    scope: null,
                    tokenType: null,
                    providerAccountId: input.providerAccountId,
                    providerEmail: `${input.sessionId}@example.com`,
                  },
                }),
              }],
            }
          : {}),
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & {
        runtimeAccountIdentitySelections?: ReadonlyArray<unknown>;
      });
    };

    registerGroupSession({ sessionId: 'source', pid: 531 });
    registerGroupSession({
      sessionId: 'same-account',
      pid: 532,
      runtimeProfileId: 'runtime-current',
      providerAccountId: 'acct-a',
    });

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'stale-profile',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('fails closed when provisional spawn identity cannot be re-proven by live runtime identity', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'runtime_state_unavailable',
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
    });
    const registerProvisionalGroupSession = (sessionId: string, pid: number, providerAccountId: string) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId: `spawn-${sessionId}`,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          source: 'spawn_selection',
          record: buildConnectedServiceCredentialRecord({
            now,
            serviceId: 'openai-codex',
            profileId: 'primary',
            kind: 'oauth',
            expiresAt: now + 60_000,
            oauth: {
              accessToken: 'access',
              refreshToken: 'refresh',
              idToken: null,
              scope: null,
              tokenType: null,
              providerAccountId,
              providerEmail: `${sessionId}@example.com`,
            },
          }),
        }],
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & {
        runtimeAccountIdentitySelections: ReadonlyArray<unknown>;
      });
      coordinator.updateSpawnTargetSessionId({ pid, sessionId });
    };

    registerProvisionalGroupSession('source', 511, 'acct-a');
    registerProvisionalGroupSession('same-account', 512, 'acct-a');

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('suppresses warmed same-account fanout when live runtime proof throws, is inexact, or mismatches', async () => {
    const cases = [
      {
        name: 'throws',
        read: async () => {
          throw new Error('runtime identity unavailable');
        },
      },
      {
        name: 'inexact',
        read: async () => ({
          status: 'inexact' as const,
          reason: 'label_only',
          runtime: { inProviderTurn: false, safeToApply: true },
        }),
      },
      {
        name: 'mismatch',
        read: async () => ({
          status: 'verified' as const,
          providerAccountId: 'acct-b',
          proofStrength: 'exact' as const,
          source: 'runtime_identity_probe' as const,
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const now = 1_000_000;
      const credentials: Credentials = {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      };
      const api = {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
        getConnectedServiceCredentialPlain: vi.fn(async () => null),
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      } as unknown as QuotaApi;
      const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
      const readRuntimeAccountIdentity = vi.fn(testCase.read);
      const coordinator = new ConnectedServiceQuotasCoordinator({
        api,
        credentials,
        quotaFetchers: [],
        now: () => now,
        randomBytes: (length: number) => randomBytes(length),
        authGroupSwitchCoordinator: { switchBeforeTurn },
        groupSwitchCheckMinIntervalMs: 0,
        sameAccountFanoutStrategyResolver: () => 'provider_account_id',
        readRuntimeAccountIdentity,
      });
      for (const [sessionId, pid] of [['source', 521], ['same-account', 522]] as const) {
        coordinator.registerSpawnTarget({
          pid,
          sessionId: `${testCase.name}-${sessionId}`,
          connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
              },
            },
          },
          connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'team',
              activeProfileId: 'primary',
              fallbackProfileId: 'backup',
              generation: 4,
            }]),
          },
        });
      }
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId: `${testCase.name}-same-account`,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });

      await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
        sourceSessionId: `${testCase.name}-source`,
        serviceId: 'openai-codex',
        groupId: 'team',
        exhaustedProfileId: 'primary',
        providerAccountId: 'acct-a',
        resetAtMs: null,
        reason: 'usage_limit',
      })).resolves.toEqual({
        status: 'recorded',
        fanoutCandidates: 0,
        fanoutRequests: 0,
      });

      expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
        sessionId: `${testCase.name}-same-account`,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        expectedGroupGeneration: 4,
      });
      expect(switchBeforeTurn).not.toHaveBeenCalled();
    }
  });

  it('reconciles cold active same-group siblings through runtime identity before declaring no fanout target', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const readRuntimeAccountIdentity = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'same-account') {
        return {
          status: 'verified' as const,
          providerAccountId: 'acct-a',
          accountLabel: 'same@example.com',
          proofStrength: 'exact' as const,
          source: 'runtime_identity_probe' as const,
          runtime: {
            inProviderTurn: true,
            safeToApply: false,
          },
        };
      }
      return {
        status: 'verified' as const,
        providerAccountId: 'acct-b',
        accountLabel: 'different@example.com',
        proofStrength: 'exact' as const,
        source: 'runtime_identity_probe' as const,
      };
    });
    const diagnostics: unknown[] = [];
    const coordinatorParams = {
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id' as const,
      runtimeAuthApplyCapabilityResolver: () => ({
        directLiveHotAuth: directLiveExternalTokenInjectionCapability.directLiveHotAuth,
      }),
      readRuntimeAccountIdentity,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      readRuntimeAccountIdentity: typeof readRuntimeAccountIdentity;
    };
    const coordinator = new ConnectedServiceQuotasCoordinator(coordinatorParams);
    for (const [sessionId, pid] of [['source', 511], ['same-account', 512], ['different-account', 513]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledTimes(2);
    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_identity_index_cold',
      sessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      sourceProfileId: 'primary',
      expectedProviderAccountId: 'acct-a',
      expectedGroupGeneration: 4,
      decisionTrace: expect.objectContaining({
        proofSource: 'runtime_identity_index',
        sourceSessionId: 'source',
        sourceProfileId: 'primary',
        expectedGroupGeneration: 4,
      }),
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
  });

  it('repairs stale expected profile and generation from exact runtime identity before fanout', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 338 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'verified' as const,
      strategy: 'provider_account_id' as const,
      providerAccountId: 'acct-a',
      accountLabel: 'same@example.com',
      proofStrength: 'exact' as const,
      source: 'runtime_identity_probe' as const,
      profileId: 'runtime-current',
      groupId: 'team',
      groupGeneration: 337,
      runtime: {
        inProviderTurn: true,
        safeToApply: false,
      },
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      runtimeAuthApplyCapabilityResolver: () => ({
        directLiveHotAuth: directLiveExternalTokenInjectionCapability.directLiveHotAuth,
      }),
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [sessionId, pid] of [['source', 541], ['same-account', 542]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'stale-daemon-profile',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'stale-daemon-profile',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).toHaveBeenCalledWith({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'stale-daemon-profile',
      expectedGroupGeneration: 4,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_stale_expected_state_reconciled',
    }));
  });

  it('suppresses stale expected-state candidates when exact runtime account identity mismatches', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 338 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'verified' as const,
      strategy: 'provider_account_id' as const,
      providerAccountId: 'acct-b',
      proofStrength: 'exact' as const,
      source: 'runtime_identity_probe' as const,
      profileId: 'runtime-current',
      groupId: 'team',
      groupGeneration: 337,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [sessionId, pid] of [['source', 551], ['same-account', 552]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'stale-daemon-profile',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'stale-daemon-profile',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_account_mismatch',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_no_matching_sessions',
    }));
  });

  it('proves shared group auth-surface siblings from registry bindings without runtime probes', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 9 }));
    const readRuntimeAccountIdentity = vi.fn(async () => {
      throw new Error('shared group fanout must not runtime-probe siblings');
    });
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [sessionId, pid] of [['source', 561], ['shared-sibling', 562]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'stale-daemon-profile',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'stale-daemon-profile',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_identity_index_cold',
      decisionTrace: expect.objectContaining({
        proofSource: 'runtime_identity_index',
        sameAccountFanoutStrategy: 'shared_group_auth_surface',
        proofKind: 'runtime_identity_index',
      }),
    }));
  });

  it('does not create a second generation consumer when durable consumption is unavailable', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 9,
    }));
    const sourceCommittedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'source-hard-limit-decision',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'claude-subscription',
        groupId: 'team',
        profileId: 'backup',
        generation: 9,
      },
    });
    const applyCommittedGeneration = vi.fn(async (input: Readonly<{
      sessionId: string;
      serviceId: string;
      groupId: string;
      activeProfileId: string;
      generation: number;
      reason: string;
    }>) => input.sessionId === 'sibling-2' && input.generation === 9
      ? {
          status: 'superseded_after_apply' as const,
          activeProfileId: 'backup-c',
          generation: 10,
        }
      : {
          status: 'observed_generation' as const,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          mode: 'hot_apply' as const,
          providerApplication: 'applied' as const,
          verificationByServiceId: {
            'claude-subscription': {
              status: 'verified' as const,
              proofStrength: 'exact' as const,
              sharedAuthSurfaceId: 'claude-team-surface',
              source: 'shared_auth_surface',
            },
          },
        });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn, applyCommittedGeneration },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      readRuntimeAccountIdentity: async () => {
        throw new Error('shared group fanout must not runtime-probe siblings');
      },
    });
    for (const [index, sessionId] of ['source', 'sibling-1', 'sibling-2', 'sibling-3', 'sibling-4'].entries()) {
      coordinator.registerSpawnTarget({
        pid: 8_000 + index,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', selection: 'group', groupId: 'team' },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 8,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      resetAtMs: null,
      reason: 'usage_limit',
      committedGeneration: sourceCommittedGeneration,
      sourceRequiresConvergence: false,
    })).resolves.toEqual({ status: 'recorded', fanoutCandidates: 4, fanoutRequests: 0 });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('fans out runtime usage-limit reports for shared auth surfaces without source provider account ids', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 9 }));
    const readRuntimeAccountIdentity = vi.fn(async () => {
      throw new Error('shared group fanout must not runtime-probe siblings');
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      readRuntimeAccountIdentity,
    });
    for (const [sessionId, pid] of [['source', 571], ['shared-sibling', 572]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'stale-daemon-profile',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'stale-daemon-profile',
      resetAtMs: null,
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
  });

  it('uses runtime failure source generation for shared auth-surface registry fanout when the source target is absent', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 216 }));
    const readRuntimeAccountIdentity = vi.fn(async () => {
      throw new Error('shared group fanout must not runtime-probe siblings');
    });
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    coordinator.registerSpawnTarget({
      pid: 572,
      sessionId: 'shared-sibling',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'team',
          activeProfileId: 'edison_bat',
          fallbackProfileId: 'backup',
          generation: 215,
        }]),
      },
    });

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source-absent-from-registry',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'edison_bat',
      resetAtMs: null,
      sourceGroupGeneration: 215,
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_identity_index_cold',
      expectedGroupGeneration: 215,
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'registry_binding_missing_group_generation',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      expectedProviderAccountId: '',
    }));
  });

  it('excludes shared group auth-surface siblings outside the source generation with registry diagnostics', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 9 }));
    const readRuntimeAccountIdentity = vi.fn(async () => {
      throw new Error('shared group fanout must not runtime-probe siblings');
    });
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [sessionId, pid, generation] of [['source', 581, 4], ['wrong-generation', 582, 5]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'stale-daemon-profile',
            fallbackProfileId: 'backup',
            generation,
          }]),
        },
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'stale-daemon-profile',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentity).not.toHaveBeenCalled();
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'registry_binding_group_generation_mismatch',
      sessionId: 'wrong-generation',
      expectedGroupGeneration: 4,
      actualGroupGeneration: 5,
      decisionTrace: expect.objectContaining({
        proofSource: 'registry_binding',
        sameAccountFanoutStrategy: 'shared_group_auth_surface',
        proofKind: 'registry_binding',
      }),
    }));
  });

  it('applies a committed same-account generation to an exact live idle sibling', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'verified' as const,
      providerAccountId: 'acct-a',
      accountLabel: 'same@example.com',
      proofStrength: 'exact' as const,
      source: 'runtime_identity_probe' as const,
      runtime: {
        inProviderTurn: false,
        safeToApply: true,
      },
    }));
    const diagnostics: unknown[] = [];
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({ outcome: 'adopted_current' as const }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
      consumeCommittedAuthGroupGeneration,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    for (const [sessionId, pid] of [['source', 601], ['idle-sibling', 602]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'member-a',
            fallbackProfileId: 'member-a',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'member-a',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'member-a',
      providerAccountId: 'acct-a',
      resetAtMs: now + 600_000,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 2,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [
        {
          sessionId: 'idle-sibling',
          activity: 'live',
          fromProfileId: 'member-a',
        },
        {
          sessionId: 'source',
          activity: 'live',
          fromProfileId: 'member-a',
        },
      ],
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_candidate_idle_deferred_to_next_spawn',
    }));
  });

  it('applies committed group truth to every live group member even when provider-account proof differs', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({ outcome: 'adopted_current' as const }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn: vi.fn() },
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        status: 'verified' as const,
        providerAccountId: sessionId === 'source' ? 'acct-old' : 'acct-other',
        accountLabel: null,
        proofStrength: 'exact' as const,
        source: 'runtime_identity_probe' as const,
        runtime: { inProviderTurn: false, safeToApply: true },
      })),
      consumeCommittedAuthGroupGeneration,
    });

    for (const [sessionId, pid, activeProfileId] of [
      ['source', 701, 'old-member'],
      ['different-account-sibling', 702, 'other-member'],
    ] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId,
            fallbackProfileId: activeProfileId,
            generation: 4,
          }]),
        },
      });
    }

    await recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'old-member',
      providerAccountId: 'acct-old',
      resetAtMs: now + 600_000,
      reason: 'usage_limit',
    });

    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessions: expect.arrayContaining([
        { sessionId: 'source', activity: 'live', fromProfileId: 'old-member' },
        { sessionId: 'different-account-sibling', activity: 'live', fromProfileId: 'other-member' },
      ]),
    }));
  });

  it('does not re-evaluate member eligibility after the source commits a hard-limit generation', async () => {
    let now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const memberStates = new Map<string, Record<string, unknown>>([
      ['primary', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 1_000,
        providerResetsAtMs: resetAtMs,
      }],
      ['backup', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 1_000,
        providerResetsAtMs: resetAtMs,
      }],
    ]);
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        v: 1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: memberStates.get(profileId) ?? {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5 }));
    const readRuntimeAccountIdentity = vi.fn(async () => ({
      status: 'verified' as const,
      strategy: 'provider_account_id' as const,
      providerAccountId: 'acct-a',
      proofStrength: 'exact' as const,
      source: 'runtime_identity_probe' as const,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
    }));
    const diagnostics: unknown[] = [];
    for (const profileId of ['primary', 'backup'] as const) {
      recordGroupMemberAccountUsageFixture(accountUsageStore, {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        groupGeneration: 4,
        snapshot: buildProviderAccountUsageSnapshotFixture({
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId,
          groupGeneration: 4,
          now,
          remainingPct: 0,
          resetsAt: resetAtMs,
        }),
      });
    }
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      runtimeQuotaSnapshots,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
      readRuntimeAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [sessionId, pid] of [['source', 571], ['same-account', 572]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'group_exhausted_no_eligible_target',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_no_matching_sessions',
    }));

    now = resetAtMs + 1;
    memberStates.set('backup', {});

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('suppresses same-account exhaustion fanout unless the provider strategy opts into exact account proof', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });
    for (const [sessionId, pid] of [['source', 111], ['same-account', 112]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('invalidates a sibling runtime account identity before same-account fanout so stale proof is not reused', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    for (const [sessionId, pid] of [['source', 121], ['same-account', 122]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    }
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    now += 1_000;
    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('invalidates runtime account identity on pid transfer before same-account fanout', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (sessionId: string, pid: number) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    };
    registerGroupSession('source', 131);
    registerGroupSession('same-account', 132);
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    coordinator.transferPid(132, 232);

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('coalesces duplicate same-account exhaustion fanout for the same provider account and reset bucket', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      recordDiagnostic: (event) => diagnostics.push(event),
      sameAccountFanoutMinIntervalMs: 60_000,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    for (const [sessionId, pid] of [['source', 201], ['same-account', 202]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_000,
      reason: 'usage_limit',
    });
    now += 10_000;
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_001,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'same_provider_account_exhaustion_coalesced',
    }));
  });

  it('does not coalesce a same-account exhaustion fanout until there is a proven sibling candidate', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 60_000,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (sessionId: string, pid: number) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    };
    registerGroupSession('source', 301);
    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_000,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    now += 10_000;
    registerGroupSession('same-account', 302);
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: null,
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    await recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_001,
      reason: 'usage_limit',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('does not coalesce same-account exhaustion fanout across independent groups', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 60_000,
      sameAccountFanoutStrategyResolver: () => 'provider_account_id',
    });
    const registerGroupSession = (sessionId: string, pid: number, groupId: string) => {
      coordinator.registerSpawnTarget({
        pid,
        sessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId,
            },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId,
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      });
    };
    registerGroupSession('source-a', 401, 'team-a');
    registerGroupSession('same-account-a', 402, 'team-a');
    registerGroupSession('source-b', 403, 'team-b');
    registerGroupSession('same-account-b', 404, 'team-b');
    for (const [sessionId, groupId] of [
      ['same-account-a', 'team-a'],
      ['same-account-b', 'team-b'],
    ] as const) {
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'openai-codex',
        groupId,
        profileId: 'primary',
        providerAccountId: 'acct-a',
        accountLabel: null,
        observedAtMs: now,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source-a',
      serviceId: 'openai-codex',
      groupId: 'team-a',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_000,
      reason: 'usage_limit',
    });
    now += 10_000;
    await recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source-b',
      serviceId: 'openai-codex',
      groupId: 'team-b',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: 1_200_001,
      reason: 'usage_limit',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('exposes fresh quota snapshots as central quota_probe_fresh proof without account-adoption proof', () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaLifecycleFreshnessMs: 60_000,
    });

    expect(coordinator.resolveQuotaProbeFreshProof({
      serviceId: 'openai-codex',
      profileId: 'backup',
      expectedAppliedIdentity: {
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'team',
        groupGeneration: 8,
        providerAccountId: 'acct-provider-a',
        materialFingerprint: 'credential-fingerprint',
      },
      snapshotAppliedIdentity: {
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'team',
        groupGeneration: 8,
        providerAccountId: 'acct-provider-a',
        materialFingerprint: 'credential-fingerprint',
      },
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now - 10_000,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 10,
          limit: 100,
          unit: 'requests',
          utilizationPct: 10,
          remainingPct: 90,
          resetsAt: now + 300_000,
          status: 'ok',
          details: {},
        }],
      },
    })).toEqual({
      status: 'proof',
      proofKind: 'quota_probe_fresh',
    });
  });

  it('settles an aggregate group probe when a credential read exceeds its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const getConnectedServiceCredentialPlain = vi.fn((input: Readonly<{
      profileId: string;
      signal?: AbortSignal;
    }>) => new Promise<null>((resolve) => {
      input.signal?.addEventListener('abort', () => resolve(null), { once: true });
    }));
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => null),
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getAccountEncryptionModeUncached: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain,
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => Date.now(),
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
    });
    const probe = coordinator.probeGroupQuotaSnapshots as unknown as (input: Readonly<{
      serviceId: 'openai-codex';
      groupId: string;
      profileIds: ReadonlyArray<string>;
      deadlineAtMs: number;
    }>) => Promise<Readonly<{
      status: 'complete' | 'incomplete';
      requestedProfileCount: number;
      completedProfileCount: number;
      completedProfileIds: ReadonlyArray<string>;
    }>>;

    const probePromise = probe.call(coordinator, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary', 'backup'],
      deadlineAtMs: Date.now() + 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const outcome = await Promise.race([
      probePromise,
      Promise.resolve('still_pending' as const),
    ]);

    expect(outcome).toEqual({
      status: 'incomplete',
      requestedProfileCount: 2,
      completedProfileCount: 0,
      completedProfileIds: [],
      reason: 'deadline_exceeded',
    });
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(getConnectedServiceCredentialPlain.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('probes requested group member quota snapshots for pre-turn selection', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: 'primary@example.com',
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: 'backup@example.com',
      },
    });
    const records = new Map([
      ['primary', primaryRecord],
      ['backup', backupRecord],
    ]);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: records.get(profileId) ?? null },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        displayName: 'Team',
        activeProfileId: 'primary',
        generation: 4,
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          strategy: 'priority',
        },
        state: { v: 1 },
        members: ['primary', 'backup'].map((profileId, index) => ({
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId,
          priority: index,
          enabled: true,
          state: {},
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
        createdAt: 1,
        updatedAt: 2,
      })),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record }): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        const profileId = record.profileId;
        return {
          v: 1,
          serviceId: 'openai-codex',
          profileId,
          fetchedAt: now,
          staleAfterMs: 300_000,
          planLabel: 'Pro',
          accountLabel: null,
          meters: [
            {
              meterId: 'weekly',
              label: 'Weekly',
              used: null,
              limit: null,
              unit: 'unknown',
              utilizationPct: profileId === 'primary' ? 95 : 20,
              remainingPct: profileId === 'primary' ? 5 : 80,
              resetsAt: now + 60_000,
              status: 'ok',
              details: {},
            },
          ],
        };
      }),
    };

    const accountUsageStore = createProviderAccountUsageStore();
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
      accountUsageStore,
      accountUsagePersistence,
    });
    const probeGroupQuotaSnapshots = (coordinator as unknown as {
      probeGroupQuotaSnapshots?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: ReadonlyArray<string>;
      }>) => Promise<void>;
    }).probeGroupQuotaSnapshots;

    expect(typeof probeGroupQuotaSnapshots).toBe('function');
    if (typeof probeGroupQuotaSnapshots !== 'function') return;

    await probeGroupQuotaSnapshots.call(coordinator, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary', 'backup'],
    });

    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(runtimeQuotaSnapshots.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'team',
      capturedAtMs: now,
    }).get('backup')?.quotaSnapshot?.effectiveRemainingPercent).toBe(80);
    await coordinator.flushInBandQuotaPersistence(2_000);
    expect(accountUsagePersistence.recordInBandSnapshot).toHaveBeenCalled();
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    })).toEqual(expect.objectContaining({
      accountLabel: null,
      recordId: expect.any(String),
    }));
  });

  it('clears stale persisted member quota blockers after a fresh usable group quota probe', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: 'backup@example.com',
      },
    });
    const group = {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          priority: 1,
          enabled: true,
          state: {
            quotaExhaustedUntilMs: now + 500_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: now - 10_000,
            providerResetsAtMs: now + 500_000,
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    } as const;
    type RuntimeStatePatchCall = Readonly<{
      serviceId: 'openai-codex';
      groupId: string;
      expectedGeneration: number;
      memberStates: ReadonlyArray<Readonly<{
        profileId: string;
        state: Record<string, unknown>;
      }>>;
    }>;
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async (_patch: RuntimeStatePatchCall) => group);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      updateConnectedServiceAuthGroupRuntimeState,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 20,
            remainingPct: 80,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
    });
    const probeGroupQuotaSnapshots = (coordinator as unknown as {
      probeGroupQuotaSnapshots?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: ReadonlyArray<string>;
      }>) => Promise<void>;
    }).probeGroupQuotaSnapshots;

    expect(typeof probeGroupQuotaSnapshots).toBe('function');
    if (typeof probeGroupQuotaSnapshots !== 'function') return;

    await probeGroupQuotaSnapshots.call(coordinator, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });

    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledTimes(1);
    const patch = updateConnectedServiceAuthGroupRuntimeState.mock.calls[0]?.[0];
    expect(patch).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedGeneration: 4,
    }));
    const memberState = patch?.memberStates?.[0]?.state as Record<string, unknown> | undefined;
    expect(memberState?.quotaExhaustedUntilMs).toBeUndefined();
    expect(memberState?.lastFailureKind).toBeUndefined();
    // Fresh usable matching quota supersedes the stale reset marker together with the
    // quota blocker; retaining it would let old quota state influence later selection.
    expect(memberState?.providerResetsAtMs).toBeUndefined();
    expect(memberState?.lastObservedAtMs).toBeUndefined();
  });

  it('does not emit quota lifecycle transitions from probe state', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const resetAtMs = now + 500_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const buildRecord = (profileId: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId,
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: `${profileId}-access`,
        refreshToken: `${profileId}-refresh`,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: `${profileId}-acct`,
        providerEmail: `${profileId}@example.com`,
      },
    });
    const records = new Map([
      ['primary', buildRecord('primary')],
      ['backup', buildRecord('backup')],
    ]);

    type MutableMemberState = Record<string, unknown>;
    const memberStates = new Map<string, MutableMemberState>([
      ['primary', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 10_000,
        providerResetsAtMs: resetAtMs,
      }],
      ['backup', {
        quotaExhaustedUntilMs: resetAtMs,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: now - 10_000,
        providerResetsAtMs: resetAtMs,
      }],
    ]);
    const buildGroup = () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: memberStates.get(profileId) ?? {},
        createdAt: 1,
        updatedAt: 2,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async (patch: Readonly<{
      memberStates: ReadonlyArray<Readonly<{ profileId: string; state: Record<string, unknown> }>>;
    }>) => {
      for (const member of patch.memberStates) {
        memberStates.set(member.profileId, { ...member.state });
      }
      return buildGroup();
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: records.get(profileId) ?? null },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
      updateConnectedServiceAuthGroupRuntimeState,
    } as unknown as QuotaApi;

    const remainingByProfileId = new Map<string, number>([['primary', 0], ['backup', 0]]);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record }): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        const remainingPct = remainingByProfileId.get(record.profileId) ?? 0;
        return {
          v: 1,
          serviceId: 'openai-codex',
          profileId: record.profileId,
          fetchedAt: now,
          staleAfterMs: 300_000,
          planLabel: 'Pro',
          accountLabel: null,
          meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 100 - remainingPct,
            remainingPct,
            resetsAt: resetAtMs,
            status: 'ok',
            details: {},
          }],
        };
      }),
    };

    const onQuotaLifecycleTransition = vi.fn(async () => {});
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
      onQuotaLifecycleTransition,
    });
    const quotaSnapshotsByProfileId = new Map<string, ConnectedServiceQuotaSnapshotV1>([
      ['primary', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      }],
      ['backup', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: resetAtMs,
          status: 'ok',
          details: {},
        }],
      }],
    ]);
    (api as any).getConnectedServiceQuotaSnapshotPlain = vi.fn(async ({ profileId }: { profileId: string }) => {
      const snapshot = quotaSnapshotsByProfileId.get(profileId);
      return snapshot
        ? {
            content: { t: 'plain' as const, v: snapshot },
            metadata: {
              fetchedAt: snapshot.fetchedAt,
              staleAfterMs: snapshot.staleAfterMs,
              status: 'ok' as const,
            },
          }
        : null;
    });
    coordinator.registerSpawnTarget({
      pid: 321,
      sessionId: 'session-quota-blocked',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'primary',
          generation: 4,
        }]),
      },
    });
    const probeGroupQuotaSnapshots = (coordinator as unknown as {
      probeGroupQuotaSnapshots: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: ReadonlyArray<string>;
      }>) => Promise<void>;
    }).probeGroupQuotaSnapshots;

    await probeGroupQuotaSnapshots.call(coordinator, {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary', 'backup'],
    });
    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();
  });

  it('emits quota blocked/recovered lifecycle transitions from live account-usage group-state changes', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const resetAtMs = now + 500_000;
    const accountUsageStore = createProviderAccountUsageStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const group = {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 2,
      })),
      createdAt: 1,
      updatedAt: 2,
    } satisfies ConnectedServiceAuthGroupV1;
    const primaryBlocked = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
      now,
      remainingPct: 0,
      resetsAt: resetAtMs,
    });
    const backupBlocked = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
      now,
      remainingPct: 0,
      resetsAt: resetAtMs,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: primaryBlocked,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: backupBlocked,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const onQuotaLifecycleTransition = vi.fn(async () => {});
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      accountUsageStore,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      onQuotaLifecycleTransition,
    });
    coordinator.registerSpawnTarget({
      pid: 321,
      sessionId: 'session-quota-blocked',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'primary',
          generation: 4,
        }]),
      },
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-quota-blocked',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
      recordId: primaryBlocked.recordId,
      snapshot: primaryBlocked,
    });
    expect(onQuotaLifecycleTransition).toHaveBeenCalledTimes(1);
    expect(onQuotaLifecycleTransition).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'blocked',
      serviceId: 'openai-codex',
      groupId: 'team',
      sessionIds: ['session-quota-blocked'],
      issueFingerprint: 'quota-blocked:openai-codex:team',
      resetAtMs,
    }));
    const blockedTransitionCall =
      (onQuotaLifecycleTransition.mock.calls as unknown as ReadonlyArray<readonly [Readonly<{ cycleId?: unknown }>]>)[0];
    const blockedCycleId = blockedTransitionCall?.[0]?.cycleId;
    expect(blockedCycleId).toBe(`reset_at_${Math.floor(resetAtMs / 60_000) * 60_000}`);

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-quota-blocked',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
      recordId: primaryBlocked.recordId,
      snapshot: primaryBlocked,
    });
    expect(onQuotaLifecycleTransition).toHaveBeenCalledTimes(1);

    const backupRecovered = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
      now: now + 1_000,
      remainingPct: 80,
      resetsAt: now + 700_000,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: backupRecovered,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
    });
    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-quota-blocked',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
      recordId: backupRecovered.recordId,
      snapshot: backupRecovered,
    });
    expect(onQuotaLifecycleTransition).toHaveBeenCalledTimes(2);
    expect(onQuotaLifecycleTransition).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'recovered',
      serviceId: 'openai-codex',
      groupId: 'team',
      sessionIds: ['session-quota-blocked'],
      issueFingerprint: 'quota-blocked:openai-codex:team',
    }));
    const recoveredTransitionCall =
      (onQuotaLifecycleTransition.mock.calls as unknown as ReadonlyArray<readonly [Readonly<{ cycleId?: unknown }>]>)[1];
    const recoveredCycleId = recoveredTransitionCall?.[0]?.cycleId;
    expect(recoveredCycleId).toBe(blockedCycleId);
  });

  it('reconstructs cold lifecycle state through connected-service aliases whose provider id differs from service id', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const resetAtMs = now + 500_000;
    const accountUsageStore = createProviderAccountUsageStore();
    const group = {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 2,
      })),
      createdAt: 1,
      updatedAt: 2,
    } satisfies ConnectedServiceAuthGroupV1;
    const primaryBlocked = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
      now,
      remainingPct: 0,
      resetsAt: resetAtMs,
    });
    const backupBlocked = buildProviderAccountUsageSnapshotFixture({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
      now,
      remainingPct: 0,
      resetsAt: resetAtMs,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: primaryBlocked,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
    });
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: backupBlocked,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 4,
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {} as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      accountUsageStore,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });
    coordinator.registerSpawnTarget({
      pid: 321,
      sessionId: 'session-quota-blocked',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'primary',
          generation: 4,
        }]),
      },
    });

    const evaluation = (coordinator as unknown as {
      evaluateGroupQuotaLifecycleFromAccountUsage(input: Readonly<{
        mode: 'cold_reconstruction';
        group: ConnectedServiceAuthGroupV1;
        changedProfileId: string;
        changedGroupGeneration: number;
        now: number;
      }>): Readonly<{
        edge: Readonly<{ phase: string }>;
        nextState: Readonly<{ status: string; resetAtMs?: number | null }>;
      }>;
    }).evaluateGroupQuotaLifecycleFromAccountUsage({
      mode: 'cold_reconstruction',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: 4,
      now,
    });

    expect(evaluation.edge).toEqual({ phase: 'no_edge' });
    expect(evaluation.nextState).toMatchObject({ status: 'blocked', resetAtMs });
  });

  it('does not emit quota lifecycle transitions when every group member is auth-invalid', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const group = {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      policy: {
        v: 1,
        autoSwitch: true,
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((profileId, index) => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId,
        priority: index,
        enabled: true,
        state: {
          credentialHealthStatus: 'needs_reauth',
          lastFailureKind: 'provider_auth_invalid',
          lastObservedAtMs: now,
        },
        createdAt: 1,
        updatedAt: 2,
      })),
      createdAt: 1,
      updatedAt: 2,
    };
    const onQuotaLifecycleTransition = vi.fn(async () => {});
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {} as unknown as QuotaApi,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
      onQuotaLifecycleTransition,
    });
    coordinator.registerSpawnTarget({
      pid: 321,
      sessionId: 'session-auth-invalid',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'primary',
          generation: 4,
        }]),
      },
    });

    await (coordinator as unknown as {
      evaluateGroupQuotaLifecycle: (input: Readonly<{ group: typeof group; now: number }>) => Promise<void>;
    }).evaluateGroupQuotaLifecycle({ group, now });

    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();
  });

  it('does not treat persisted connected-service quota snapshots as auth-group quota selection authority', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const existingSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'idle-backup',
      fetchedAt: now - 1_000,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'backup@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'idle-backup', status: 'connected' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: existingSnapshot },
        metadata: { fetchedAt: now - 1_000, staleAfterMs: 300_000, status: 'ok' as const },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      runtimeQuotaSnapshots,
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    await coordinator.tickOnce();

    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(runtimeQuotaSnapshots.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: now,
    }).get('idle-backup')).toBeUndefined();
  });

  it('does not expose the obsolete persisted auth-group quota hydrator', () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'backup',
      fetchedAt: now - 5_000,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'backup@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 10,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async ({ profileId }: { profileId: string }) => profileId === 'backup'
        ? {
            content: { t: 'plain' as const, v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' as const },
          }
        : null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      runtimeQuotaSnapshots,
      accountUsageStore,
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const hydratePersistedQuotaSnapshotsForGroup = (coordinator as unknown as {
      hydratePersistedQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: ReadonlyArray<string>;
      }>) => Promise<void>;
    }).hydratePersistedQuotaSnapshotsForGroup;

    expect(hydratePersistedQuotaSnapshotsForGroup).toBeUndefined();
    expect(api.getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
    })).toBeNull();
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'profile',
    })).toBeNull();
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'group_member',
      groupId: 'main',
    })).toBeNull();
  });

  it('derives a non-ok metadata status when all meters are unavailable', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedStatus: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: ProviderUsageRegisterArgs) => {
        uploadedStatus = params.metadata?.status ?? null;
      }),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: null,
            resetsAt: null,
            status: 'unavailable',
            details: {},
          },
        ],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(uploadedStatus).toBe('unavailable');
  });

  it('supports profile ids that contain ":"', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work:us',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (
        args: Parameters<QuotaApi['getConnectedServiceCredentialSealed']>[0],
      ): Promise<SealedCredentialResponse | null> => {
        if (args.profileId !== 'work:us') return null;
        return sealedCredential;
      }),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (_args: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work:us' } },
      },
    });

    await coordinator.tickOnce();
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work:us' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('polls quota/account-usage with broker-owned access only and does not expose refresh tokens to fetchers', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const freshRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: staleRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({ record: freshRecord, reauthRequired: false }));
    let observedAccessToken: string | null = null;
    let observedRefreshTokenVisible = true;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        observedAccessToken = inputRecord.kind === 'oauth' ? inputRecord.oauth.accessToken : null;
        observedRefreshTokenVisible = inputRecord.kind === 'oauth' && 'refreshToken' in inputRecord.oauth;
        return {
          v: 1,
          serviceId: inputRecord.serviceId,
          profileId: inputRecord.profileId,
          fetchedAt: now,
          staleAfterMs: 300_000,
          planLabel: 'Pro',
          accountLabel: 'user@example.com',
          meters: [],
        };
      }),
    };

    const params = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & Readonly<{
      refreshConnectedServiceCredentialForQuota: typeof refreshConnectedServiceCredentialForQuota;
    }>;
    const coordinator = new ConnectedServiceQuotasCoordinator(params);
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(observedAccessToken).toBe('stale-access');
    expect(observedRefreshTokenVisible).toBe(false);
  });

  it('does not refresh OAuth credentials when quota polling sees a provider auth failure', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const freshRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: staleRecord } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({ record: freshRecord, reauthRequired: false }));
    let attempts = 0;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        attempts += 1;
        throw Object.assign(new Error(`provider auth failed for ${inputRecord.profileId}`), {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
    };
    const params = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & Readonly<{
      refreshConnectedServiceCredentialForQuota: typeof refreshConnectedServiceCredentialForQuota;
    }>;
    const coordinator = new ConnectedServiceQuotasCoordinator(params);
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(attempts).toBe(1);
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
  });

  it('keeps quota 403 failures retryable and triggers a credential refresh probe instead of needs-reauth', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => null);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError(
          'Claude subscription is missing Claude Code OAuth scope; reconnect Claude in Happier and retry.',
          {
            status: 403,
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'missing_claude_code_scope',
          },
        );
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'legacy' } },
      },
    });

    await coordinator.tickOnce();

    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      force: true,
      reason: 'auth_failure',
    });
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'missing_claude_code_scope',
      },
    });
  });

  it('keeps provider-specific error codes retryable unless the fetcher marks reconnect required', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => null);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError(
          'Provider-owned code is diagnostic unless explicitly classified.',
          {
            status: 401,
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'missing_claude_code_scope',
          },
        );
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'legacy' } },
      },
    });

    await coordinator.tickOnce();

    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_401',
        providerHttpStatus: 401,
        providerErrorCode: 'missing_claude_code_scope',
      },
    });
  });

  it('keeps transient unrecovered quota 401 failures retryable before reconnect escalation', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => null);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('provider auth failed'), {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    now += 10_000;
    await coordinator.tickOnce();

    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenNthCalledWith(1, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: 1_000_000,
        lastRefreshFailureAt: 1_000_000,
        lastRefreshFailureKind: 'provider_401',
        providerHttpStatus: 401,
      },
    });
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenNthCalledWith(2, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: 1_010_000,
        lastRefreshFailureAt: 1_010_000,
        lastRefreshFailureKind: 'provider_401',
        providerHttpStatus: 401,
      },
    });
  });

  it('escalates repeated unrecovered quota 401 failures after the quota backoff retry window', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => null);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('provider auth failed'), {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    for (const advanceMs of [0, 10_000, 20_000, 40_000, 60_000]) {
      now += advanceMs;
      await coordinator.tickOnce();
    }

    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledTimes(1);
    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenLastCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
      reason: 'auth_failure',
    });
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(5);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenNthCalledWith(5, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: 1_130_000,
        lastRefreshFailureAt: 1_130_000,
        lastRefreshFailureKind: 'provider_401',
        providerHttpStatus: 401,
      },
    });
  });

  it('does not overwrite successful quota-triggered refresh health with the stale quota failure', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access-before-refresh',
        refreshToken: 'refresh-before-refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 8 * 3_600_000,
      oauth: {
        accessToken: 'access-after-refresh',
        refreshToken: 'refresh-after-refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth,
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({
      record: refreshedRecord,
      reauthRequired: false,
    }));
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('provider auth failed'), {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    for (const advanceMs of [0, 10_000, 20_000, 40_000, 60_000]) {
      now += advanceMs;
      await coordinator.tickOnce();
    }

    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledTimes(1);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(4);
    for (const [input] of updateConnectedServiceCredentialHealth.mock.calls) {
      expect(input).toMatchObject({
        serviceId: 'claude-subscription',
        profileId: 'work',
        expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
        health: { status: 'refresh_failed_retryable' },
      });
    }
  });

  it('latches needs_reauth and stops probing when the refresh probe proves reconnect is required', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'dead',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'invalidated-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-dead',
        providerEmail: 'dead@example.com',
      },
    });
    // Simulates the refresh coordinator persisting the needs_reauth latch server-side when its
    // provider refresh fails permanently (401 refresh_token_invalidated).
    let latchedStatus: 'connected' | 'needs_reauth' = 'connected';
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
      listConnectedServiceProfiles: vi.fn(async () => ({
        profiles: [{ profileId: 'dead', status: latchedStatus }],
      })),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => {
      latchedStatus = 'needs_reauth';
      return { record: null, reauthRequired: true };
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('provider auth failed'), {
          quotaFetchErrorCode: 'auth_failure',
          status: 401,
        });
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'dead' } },
      },
    });

    for (const advanceMs of [0, 10_000, 20_000, 40_000, 60_000]) {
      now += advanceMs;
      await coordinator.tickOnce();
    }

    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).toHaveBeenCalledTimes(5);
    // The refresh coordinator's needs_reauth verdict must NOT be clobbered with a retryable status:
    // only the four pre-probe failures write retryable health.
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(4);
    for (const call of (api.updateConnectedServiceCredentialHealth as ReturnType<typeof vi.fn>).mock.calls) {
      expect((call[0] as { health: { status: string } }).health.status).toBe('refresh_failed_retryable');
    }

    // Excluded from proactive probing until reconnected (well past the failure backoff window).
    now += 120_000;
    await coordinator.tickOnce();
    expect(fetcher.fetch).toHaveBeenCalledTimes(5);
    expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledTimes(1);
  });

  it('latches needs_reauth when the quota fetcher marks the auth failure reconnect-required', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => null);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      fetch: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError(
          'Claude subscription is missing Claude Code OAuth scope; reconnect Claude in Happier and retry.',
          {
            status: 403,
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'missing_claude_code_scope',
            reconnectRequired: true,
          },
        );
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'legacy' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'missing_claude_code_scope',
      },
    });
  });

  it('does not poison credential health when the quota endpoint is missing with 404', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'eligible',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'eligible-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-eligible',
        providerEmail: 'eligible@example.test',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({ record, reauthRequired: false }));
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => {
        throw new ConnectedServiceQuotaFetchError(
          'OpenAI usage endpoint not found',
          {
            status: 404,
            quotaFetchErrorCode: 'auth_failure',
          },
        );
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      refreshConnectedServiceCredentialForQuota,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'eligible' } },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('uses provider Retry-After quota errors as binding backoff', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('provider busy'), { retryAfterMs: 120_000 });
      }),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      failureBackoffMinMs: 1,
      failureBackoffMaxMs: 1,
      failureBackoffJitterPct: 0,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    now += 60_000;
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not wedge the tick if a fetcher ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (_args: FetchArgs) => new Promise<null>(() => {})),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      fetchTimeoutMs: 10,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    let settled = false;
    const tick = coordinator.tickOnce().finally(() => {
      settled = true;
    });
    void tick;

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it('supports dataKey credentials when sealing and opening snapshots', async () => {
    const now = 1_000_000;

    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'dataKey', machineKey },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

	    let uploadedCiphertext: string | null = null;
	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: ProviderUsageRegisterArgs) => {
	        uploadedCiphertext = params.sealed.ciphertext;
	      }),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
	        v: 1,
	        serviceId: inputRecord.serviceId,
	        profileId: inputRecord.profileId,
	        fetchedAt: now,
	        staleAfterMs: 300_000,
	        planLabel: 'Pro',
	        accountLabel: 'user@example.com',
	        meters: [],
	      })),
	    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'provider_account_usage_snapshot',
      material: { type: 'dataKey', machineKey },
      ciphertext: uploadedCiphertext ?? '',
    });
    expect(opened?.value).toBeTruthy();
  });

  it('forces a refresh when the server reports refreshRequestedAt newer than fetchedAt', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async () => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', fetch: vi.fn(async (_args: FetchArgs) => null) };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts quota fetchers that exceed the timeout', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

	    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
	      kind: 'connected_service_credential',
	      material: { type: 'legacy', secret: credentials.encryption.secret },
	      payload: record,
	      randomBytes: (length) => randomBytes(length),
	    });
	    const sealedCredential: SealedCredentialResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
	      metadata: { kind: 'oauth' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      fetch: vi.fn(async ({ signal }: FetchArgs) => {
	        await new Promise<void>((_resolve, reject) => {
	          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	        });
	        return null;
	      }),
	    };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	      fetchTimeoutMs: 5,
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    const pending = coordinator.tickOnce();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBeUndefined();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips fetching when the server snapshot is still fresh', async () => {
    const now = 1_000_000;
	    const credentials: Credentials = {
	      token: 'happy-token',
	      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
	    };
	    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

	    const existingSnapshot: SealedQuotaSnapshotResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
	      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
	      getConnectedServiceCredentialSealed: vi.fn(async () => null),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', fetch: vi.fn(async (_args: FetchArgs) => null) };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('uses a shared lease so contending daemons do not duplicate stale quota fetches', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const staleSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now - 60_000,
      staleAfterMs: 1_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [],
    };
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      ...staleSnapshot,
      fetchedAt: now,
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 1,
          limit: 10,
          unit: 'count',
          utilizationPct: 10,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };

    let serverSnapshot: ConnectedServiceQuotaSnapshotV1 = staleSnapshot;
    let leaseOwner: string | null = null;
    let releaseFirstFetch: () => void = () => {};
    let releaseSleep: () => void = () => {};

    const apiWithLease = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: serverSnapshot },
        metadata: {
          fetchedAt: serverSnapshot.fetchedAt,
          staleAfterMs: serverSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {
        serverSnapshot = freshSnapshot;
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      acquireConnectedServiceRefreshLease: vi.fn(async (params: Readonly<{ ownerId?: string; leaseMs: number }>) => {
        const ownerId = params.ownerId ?? 'legacy-owner';
        if (!leaseOwner || leaseOwner === ownerId) {
          leaseOwner = ownerId;
          return { acquired: true, leaseUntil: now + params.leaseMs };
        }
        return { acquired: false, leaseUntil: now + 50 };
      }),
    };
    const api: QuotaApi = apiWithLease;

    let fetchCallCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
        return freshSnapshot;
      }
      return freshSnapshot;
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: fetchMock,
    };

    const sleepMs = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    });

    const common = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaFetchLeaseMs: 10_000,
      quotaFetchLeaseContentionWaitMaxMs: 100,
      sleepMs,
    };
    const coordinatorA = new ConnectedServiceQuotasCoordinator({
      ...common,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
    });
    const coordinatorB = new ConnectedServiceQuotasCoordinator({
      ...common,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-b',
    });

    for (const coordinator of [coordinatorA, coordinatorB]) {
      coordinator.registerSpawnTarget({
        pid: coordinator === coordinatorA ? 123 : 456,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
      });
    }

    const tickA = coordinatorA.tickOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const tickB = coordinatorB.tickOnce();
    await vi.waitFor(() => {
      if (sleepMs.mock.calls.length === 0 && fetchMock.mock.calls.length < 2) {
        throw new Error('waiting for quota lease contention');
      }
    });

    releaseFirstFetch();
    await tickA;
    releaseSleep();
    await tickB;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiWithLease.getConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(3);
    expect(sleepMs).toHaveBeenCalledWith(50);
  });

  it('backs off instead of fetching provider quotas when lease acquisition fails', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const apiWithFailingLease = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => {
        throw new Error('lease service unavailable');
      }),
    };
    const api: QuotaApi = apiWithFailingLease;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();

    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(apiWithFailingLease.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(apiWithFailingLease.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(apiWithFailingLease.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the fetcher fails', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

	    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
	      kind: 'connected_service_credential',
	      material: { type: 'legacy', secret: credentials.encryption.secret },
	      payload: record,
	      randomBytes: (length) => randomBytes(length),
	    });
	    const sealedCredential: SealedCredentialResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
	      metadata: { kind: 'oauth' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      fetch: vi.fn(async (_args: FetchArgs) => {
	        throw new Error('boom');
	      }),
	    };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();
  });

  it('applies a failure backoff window per binding', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      discoveryEnabled: false,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
  });

  it('applies failure backoff even when refreshRequestedAt remains newer than fetchedAt', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      discoveryEnabled: false,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
  });

  it('can discover connected profiles when enabled', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedCiphertext: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: ProviderUsageRegisterArgs) => {
        uploadedCiphertext = params.sealed.ciphertext;
      }),
    } satisfies QuotaApi;
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: true,
      discoveryIntervalMs: 1,
      failureBackoffJitterPct: 0,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.tickOnce();

    expect((api as any).listConnectedServiceProfiles).toHaveBeenCalled();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');
  });

  it('queues in-band quota observations and persists provider-account usage without invoking provider polling', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 5_000,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [
          {
            meterId: 'primary',
            label: 'Primary',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 88,
            resetsAt: null,
            status: 'ok',
            details: {},
          },
        ],
      },
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });

    expect(fetcher.fetch).not.toHaveBeenCalled();
    await coordinator.flushInBandQuotaPersistence(1_000);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      recordId: expect.any(String),
      content: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          providerId: 'openai-codex',
          recordKey: expect.objectContaining({ accountSubjectId: 'legacy-connected-service:openai-codex:work' }),
        }),
      }),
      metadata: expect.objectContaining({ fetchedAt: now, staleAfterMs: 300_000, status: 'ok' }),
    }));
  });

  it('rejects in-band quota snapshots whose embedded service id does not match the write key', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinFreshnessRefreshMs: 5_000,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
        fetchedAt: now,
        staleAfterMs: 300_000,
        providerId: 'claude',
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'suppressed', reason: 'service_id_mismatch' });

    await coordinator.flushInBandQuotaPersistence(1_000);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).registerProviderAccountUsageSnapshotSealed).not.toHaveBeenCalled();
  });

  it('does not persist unchanged in-band quota snapshots every five seconds by default', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    now += 6_000;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'suppressed', reason: 'unchanged' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('keeps a server refresh marker material after a background read so the next in-band snapshot persists', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });
    const oldSnapshot = makeSnapshot(now);
    const refreshRequestedAt = now + 500;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: oldSnapshot },
        metadata: {
          fetchedAt: oldSnapshot.fetchedAt,
          staleAfterMs: oldSnapshot.staleAfterMs,
          status: 'ok' as const,
          refreshRequestedAt,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: oldSnapshot,
    });
    await coordinator.flushInBandQuotaPersistence(1_000);

    await coordinator.tickOnce();

    now = refreshRequestedAt + 1;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
  });

  it('moves in-band quota persistence to the hydrated account scope after credentials gain a JWT', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: '',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    credentials.token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxdW90YS1hY2N0In0.signaturepart';
    now += 1_000;

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-band quota snapshots and flushes the latest payload', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const writtenRemaining: number[] = [];
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async (params: ProviderUsageRegisterPlainArgs) => {
        writtenRemaining.push(Number(params.content.v.meters[0]?.remainingPct ?? -1));
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 5_000,
    });

    const makeSnapshot = (remainingPct: number, fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: null,
        limit: null,
        unit: 'unknown',
        utilizationPct: 100 - remainingPct,
        remainingPct,
        resetsAt: null,
        status: 'ok',
        details: {},
      }],
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(80, now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    now += 1_000;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(9, now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    now += 100;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(8, now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'coalesced' });

    await coordinator.flushInBandQuotaPersistence(1_000);

    expect(writtenRemaining).toEqual([80, 8]);
  });

  it('resolves account encryption mode at in-band flush time', async () => {
    const now = 1_000_000;
    let connected = false;
    let accountMode: 'plain' | 'e2ee' = 'plain';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => accountMode),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceIsConnected: () => connected,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    expect(api.getAccountEncryptionMode).not.toHaveBeenCalled();

    accountMode = 'e2ee';
    connected = true;
    await coordinator.flushInBandQuotaPersistence(1_000);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
  });

  it('defers in-band quota persistence when account mode is unknown at flush time', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode unavailable');
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 5_000,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });

    await coordinator.flushInBandQuotaPersistence(25);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).registerProviderAccountUsageSnapshotSealed).not.toHaveBeenCalled();
  });

  it('does not pause same-fingerprint in-band persistence after account mode recovers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let now = 1_000_000;
    let modeUnavailable = true;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        if (modeUnavailable) throw new Error('mode unavailable');
        return 'plain' as const;
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 0,
      quotaPersistenceBackoffBaseMs: 10,
      quotaPersistenceBackoffMaxMs: 10,
      quotaPersistenceBackoffJitterRatio: 0,
      quotaPersistenceMaxConsecutiveFailures: 1,
    });
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [],
    };

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot,
    });
    const failedFlush = coordinator.flushInBandQuotaPersistence(1);
    await vi.advanceTimersByTimeAsync(1);
    await failedFlush;

    modeUnavailable = false;
    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot,
    });
    const recoveryFlush = coordinator.flushInBandQuotaPersistence(100);
    await vi.advanceTimersByTimeAsync(100);
    await recoveryFlush;

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('does not resolve account mode when daemon server work gate defers persistence', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async () => ({ status: 'deferred' as const, reason: 'offline' })),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['quotaPersistenceServerWorkScheduler']>;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceServerWorkScheduler: serverWorkScheduler,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });

    await coordinator.flushInBandQuotaPersistence(25);

    expect(serverWorkScheduler.enqueue).toHaveBeenCalled();
    expect(api.getAccountEncryptionMode).not.toHaveBeenCalled();
  });

  it('reports quota persistence flush timeout so pending server work can survive shutdown', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async () => ({ status: 'deferred' as const, reason: 'offline' })),
      flushAll: vi.fn(async () => ({ timedOut: true })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 1,
        pendingPayloadBytes: 128,
        purposes: {
          connectedServiceQuotaPersistence: {
            counters: {
              accepted: 1,
              coalesced: 0,
              suppressed: 0,
              written: 0,
              failed: 0,
              deferred: 1,
              retried: 0,
            },
          },
        },
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['quotaPersistenceServerWorkScheduler']>;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceServerWorkScheduler: serverWorkScheduler,
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    });

    await expect(coordinator.flushInBandQuotaPersistence(25)).resolves.toEqual({
      timedOut: true,
      inProcess: { timedOut: true, drained: false },
      serverWork: { timedOut: true },
    });
    expect(serverWorkScheduler.getSnapshot().pendingKeyCount).toBe(1);
  });

  it('combines in-process quota persistence timeout state with server-work flush state', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    const accountMode = createDeferred<'plain'>();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => await accountMode.promise),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 0,
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    });

    const flushed = coordinator.flushInBandQuotaPersistence(25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(flushed).resolves.toEqual({
      timedOut: true,
      inProcess: { timedOut: true, drained: false },
      serverWork: null,
    });
  });

  it('uses daemon server-work Retry-After outcomes as quota persistence backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async (request) => {
        if (serverWorkScheduler.enqueue.mock.calls.length === 1) {
          return {
            status: 'failed' as const,
            classification: {
              kind: 'rate_limited' as const,
              retryable: true,
              statusCode: 429,
              retryAfterMs: 5_000,
            },
          };
        }
        await request.run(request.payload);
        return { status: 'written' as const };
      }),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['quotaPersistenceServerWorkScheduler']>;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceServerWorkScheduler: serverWorkScheduler,
      quotaPersistenceMinIntervalMs: 0,
      quotaPersistenceBackoffBaseMs: 100,
      quotaPersistenceBackoffMaxMs: 100,
      quotaPersistenceBackoffJitterRatio: 0,
      quotaPersistenceMaxConsecutiveFailures: 10,
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    });
    const initialFlush = coordinator.flushInBandQuotaPersistence(20);
    await vi.advanceTimersByTimeAsync(20);
    await initialFlush;

    expect(serverWorkScheduler.enqueue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_979);
    expect(serverWorkScheduler.enqueue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(serverWorkScheduler.enqueue).toHaveBeenCalledTimes(2);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('does not mirror server-work owned write attempt counters from the latest-work scheduler', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async (request) => {
        await request.run(request.payload);
        return { status: 'written' as const };
      }),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['quotaPersistenceServerWorkScheduler']>;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceServerWorkScheduler: serverWorkScheduler,
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'pro',
        accountLabel: null,
        meters: [],
      },
    });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect(serverWorkScheduler.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'accepted' }));
    expect(serverWorkScheduler.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'written' }));
    expect(serverWorkScheduler.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'failed' }));
    expect(serverWorkScheduler.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'retried' }));
  });
});
