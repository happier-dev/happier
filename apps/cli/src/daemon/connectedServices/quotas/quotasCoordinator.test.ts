import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  buildProviderAccountUsageRecordId,
  ConnectedServiceQuotaSnapshotV1Schema,
  FeaturesResponseSchema,
  openProviderAccountUsageSnapshotCiphertext,
  projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageSnapshotV1Schema,
  QualifiedProviderAccountUsageWriteV4Schema,
  sealAccountScopedBlobCiphertext,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import {
  sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext,
} from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import type {
  BuiltInLegacyConnectedAccountOperation,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageRecordKeyV1,
  ProviderAccountUsageSnapshotV1,
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';
import type { AgentAccountUsageSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpStatusError } from '@/api/client/httpStatusError';
import {
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '@/daemon/serverWork';
import type { Credentials, StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountRuntimeEstablishedOperation,
  ConnectedAccountRuntimeEstablishedResult,
} from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import {
  createProviderAccountUsagePersistenceScheduler,
} from '../accountUsage/persistence';
import {
  buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation,
} from '../accountUsage/fromConnectedServiceQuotaObservation';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
  type QualifiedConnectedAccountEstablishedInvocationBasis,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';

type AccountExhaustionInput = Parameters<ConnectedServiceQuotasCoordinator['recordAccountExhaustionAndFanout']>[0];
type RuntimeUsageLimitInput = Parameters<ConnectedServiceQuotasCoordinator['recordRuntimeUsageLimitExhaustionAndFanout']>[0];

function hardLimitCommittedGenerationForTest(input: Readonly<{
  serviceId: AccountExhaustionInput['serviceId'];
  groupId: string;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}>) {
  return buildConnectedServiceAuthGroupCommittedGenerationFact({
    decisionId: `test-hard-limit\0${input.serviceId}\0${input.groupId}`,
    provenance: 'hard_limit',
    decisionCommittedTarget: {
      serviceId: input.serviceId,
      groupId: input.groupId,
      profileId: 'backup',
      generation: 2,
      ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
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
  const groupId = typeof input.groupId === 'string' ? input.groupId : '';
  return owner.recordRuntimeUsageLimitExhaustionAndFanout({
    ...input,
    committedGeneration: input.committedGeneration
      ?? (groupId ? hardLimitCommittedGenerationForTest({ serviceId: input.serviceId, groupId }) : null),
  });
}
import {
  ConnectedServiceQuotasCoordinator,
  type QualifiedConnectedAccountQuotaRuntime,
} from './ConnectedServiceQuotasCoordinator';
import { QuotaFetchError, type ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
type QualifiedProviderAccountUsageWriteArgs = Readonly<{
  token: string;
  write: import('zod').output<typeof QualifiedProviderAccountUsageWriteV4Schema>;
}>;
type FetchArgs = Parameters<ConnectedServiceQuotaFetcher['loadQuota']>[0];
type SealedCredentialResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceCredentialSealed']>>>;
type SealedQuotaSnapshotResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>>;
type ConnectedServiceAuthGroupResponse = ConnectedServiceAuthGroupV1;
type LegacyConnectedServiceAuthGroupReader = (params: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  signal?: AbortSignal;
}>) => Promise<ConnectedServiceAuthGroupResponse | null>;
type SameAccountFanoutStrategy = 'provider_account_id' | 'shared_group_auth_surface' | 'none';

function readSealedQualifiedProviderAccountUsageCiphertext(
  params: QualifiedProviderAccountUsageWriteArgs,
): string | null {
  const sealedPayload = params.write.sealedPayload;
  return params.write.payloadMode === 'sealed_account_scoped_v1' && sealedPayload
    ? sealedPayload.ciphertext
    : null;
}

function createQuotaFixtureAccountStorageDependencies(): AccountPluginDataStorageHostDependencies {
  const credentials = Object.freeze({
    token: 'quota-fixture-account-token',
    encryption: null,
  } satisfies StoredCredentials);

  return Object.freeze({
    readCredentials: async () => credentials,
    isCurrentAccount: (candidate) => candidate === credentials,
    resolveAccountScopeKey: () => 'quota-fixture-account',
    resolveBaseUrl: () => 'https://quota-fixture-account.invalid',
    resolveAccountEncryptionCurrentness: async () => ({
      mode: 'plain' as const,
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    }),
    http: {
      async get(url: string) {
        if (url.endsWith('/v1/account/encryption')) {
          return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        }
        throw new Error(`Unexpected quota fixture Account Data GET: ${url}`);
      },
      async post(url: string) {
        if (url.endsWith('/v1/plugins/data/query')) {
          return { status: 200, data: { rows: [], changeCursor: 0 } };
        }
        throw new Error(`Unexpected quota fixture Account Data POST: ${url}`);
      },
    },
  });
}

type RuntimeIdentityFanoutCoordinator = ConnectedServiceQuotasCoordinator & Readonly<{
  recordRuntimeAccountIdentityFromSnapshot(input: Readonly<{
    sessionId: string;
    serviceId: 'openai-codex' | 'claude-subscription';
    groupId: string | null;
    profileId: string;
    providerAccountId: string;
    accountLabel: string | null;
    observedAtMs: number;
    source: 'runtime_quota_snapshot' | 'active_account_verification' | 'runtime_auth_failure_report';
    proofStrength: 'exact' | 'weak';
    groupGeneration: number | null;
  }>): unknown;
  recordAccountExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: 'openai-codex' | 'claude-subscription';
    groupId: string;
    exhaustedProfileId: string;
    providerAccountId: string;
    resetAtMs: number | null;
    reason: 'usage_limit';
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
      fanoutRequests: number;
    }>>;
  recordRuntimeUsageLimitExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: 'openai-codex' | 'claude-subscription';
    groupId: string | null;
    exhaustedProfileId: string | null;
    sourceProviderAccountId?: string | null;
    sourceAccountLabel?: string | null;
    sourceGroupGeneration?: number | null;
    resetAtMs: number | null;
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
    fanoutRequests: number;
  }>>;
}>;

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

function buildAgentAccountUsageSnapshotFixture(input: Readonly<{
  record: FetchArgs['record'];
  now: number;
  staleAfterMs?: number;
  providerId?: string;
  accountSubjectId?: string;
  subjectKind?: AgentAccountUsageSnapshot['recordKey']['subjectKind'];
  planLabel?: string | null;
  accountLabel?: string | null;
  recoveryCredits?: AgentAccountUsageSnapshot['recoveryCredits'];
  meters?: AgentAccountUsageSnapshot['meters'];
  state?: AgentAccountUsageSnapshot['state'];
}>): AgentAccountUsageSnapshot {
  const credentialProviderAccountId = input.record.kind === 'oauth'
    ? input.record.oauth.providerAccountId
    : input.record.kind === 'token'
      ? input.record.token.providerAccountId
      : null;
  const accountSubjectId = input.accountSubjectId
    ?? credentialProviderAccountId?.trim()
    ?? '';
  if (!accountSubjectId) {
    throw new Error('semantic quota fixture requires a provider account subject');
  }
  const providerId = input.providerId ?? input.record.serviceId;
  const meters = input.meters ?? [];
  return {
    v: 1,
    recordKey: {
      providerId,
      accountSubjectId,
      subjectKind: input.subjectKind ?? 'account',
      quotaScope: 'account',
    },
    providerId,
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: input.now,
    fetchedAtMs: input.now,
    staleAfterMs: input.staleAfterMs ?? 300_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: input.state ?? (meters.length > 0 ? 'loaded_data' : 'loaded_empty'),
    planLabel: input.planLabel ?? null,
    accountLabel: input.accountLabel ?? null,
    ...(input.recoveryCredits === undefined
      ? {}
      : { recoveryCredits: input.recoveryCredits }),
    meters,
  };
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
  getConnectedServiceAuthGroup: LegacyConnectedServiceAuthGroupReader;
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
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
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
  return {
    runtimeQuotaSnapshots,
    accountUsageStore,
    getConnectedServiceAuthGroup: vi.fn(async (): Promise<ConnectedServiceAuthGroupResponse> => ({
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
        v: 1,
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
    })),
  };
}

function buildConnectedGroupProviderAccountUsageSnapshot(input: Readonly<{
  profileId: string;
  now: number;
  remainingPct: number;
  resetAtMs?: number | null;
  groupGeneration?: number;
}>): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: `acct_${input.profileId}`,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: {
      kind: 'providerSubject',
      id: recordKey.accountSubjectId,
    },
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
      resetsAt: input.resetAtMs ?? null,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

function buildConnectedGroupProviderAccountUsageObservation(input: Readonly<{
  profileId: string;
  groupGeneration?: number;
}>) {
  return {
    sources: [{
      serviceId: 'openai-codex' as const,
      profileId: input.profileId,
      bindingKind: 'group_member' as const,
      groupId: 'team',
      ...(input.groupGeneration === undefined ? {} : { groupGeneration: input.groupGeneration }),
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

describe('ConnectedServiceQuotasCoordinator', () => {
  it('canonicalizes a legacy scalar quota observation into a qualified V4 PAU write', async () => {
    const now = 1_000_000;
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
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
    const publicSnapshot = {
      v: 1,
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'acct',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      providerId: 'openai-codex',
      accountSubject: { kind: 'providerSubject', id: 'acct' },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: 300_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [],
    } satisfies AgentAccountUsageSnapshot;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const profile = {
      ref: {
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        accountId: 'work',
      },
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationReady: true,
      configurationRevision: null,
      providerIdentity: { accountId: 'acct' },
      displayName: 'Work',
      scopes: [],
    } satisfies QualifiedConnectedAccountProfileV4;
    const writeProviderAccountUsage = vi.fn(async () => ({ success: true as const }));
    const fetcher = {
      serviceId: 'openai-codex' as const,
      loadQuota: vi.fn(async () => publicSnapshot),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'revisioned_v2_v3' as const,
        establishedRuntimeOwner: { invokeWithReceipt: vi.fn() },
        listScheduledAccounts: vi.fn(async () => []),
        listAccounts: vi.fn(async () => [profile]),
        writeProviderAccountUsage,
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledOnce();
    expect(writeProviderAccountUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-only',
        write: expect.objectContaining({
          source: { ref: profile.ref, bindingKind: 'account' },
          expectedCredentialRevision: profile.credentialRevision,
          expectedConfigurationRevision: null,
          recordId: buildProviderAccountUsageRecordId(publicSnapshot.recordKey),
          payloadMode: 'plain_json_v1',
          snapshot: expect.objectContaining({
            providerId: 'openai-codex',
            recordKey: publicSnapshot.recordKey,
          }),
        }),
      }),
    );
  });

  it('drops a quota response when its fetched credential is superseded before local quota effects', async () => {
    const now = 1_000_000;
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    const recordA = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access-a',
        refreshToken: 'refresh-a',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-a',
        providerEmail: 'a@example.com',
      },
    });
    const recordB = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access-b',
        refreshToken: 'refresh-b',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-b',
        providerEmail: 'b@example.com',
      },
    });
    let currentCredential = {
      record: recordA,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const staleSnapshot = {
      v: 1,
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'acct-a',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      providerId: 'openai-codex',
      accountSubject: { kind: 'providerSubject', id: 'acct-a' },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: 300_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'Pro',
      accountLabel: 'a@example.com',
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
        details: { limitCategory: 'usage_limit' },
      }],
    } satisfies AgentAccountUsageSnapshot;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const recordProfileSnapshot = vi.spyOn(
      softSwitchEligibility.runtimeQuotaSnapshots,
      'recordProfileSnapshot',
    );
    const recordAccountUsageSnapshot = vi.spyOn(
      softSwitchEligibility.accountUsageStore,
      'recordSnapshot',
    );
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => undefined);
    const getConnectedServiceAuthGroup = vi.fn(async () => {
      const group = await softSwitchEligibility.getConnectedServiceAuthGroup!({
        serviceId: 'openai-codex',
        groupId: 'team',
      });
      if (!group) return null;
      return {
        ...group,
        members: group.members.map((member) => member.profileId === 'active'
          ? {
              ...member,
              state: {
                ...member.state,
                lastFailureKind: 'usage_limit',
                lastObservedAtMs: now - 1,
                quotaExhaustedUntilMs: now + 60_000,
              },
            }
          : member),
      };
    });
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({
        status: 'enqueued' as const,
        enqueue: 'accepted' as const,
      })),
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: currentCredential.record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: currentCredential.credentialRevision,
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupRuntimeState,
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => undefined),
    } as unknown as QuotaApi;
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let resolveQuota!: (snapshot: AgentAccountUsageSnapshot) => void;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
        signalFetchStarted();
        return await new Promise<AgentAccountUsageSnapshot>((resolve) => {
          resolveQuota = resolve;
        });
      }),
    };
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
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

    const ticking = coordinator.tickOnce();
    await fetchStarted;
    currentCredential = {
      record: recordB,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRT',
    };
    resolveQuota(staleSnapshot);
    await ticking;

    expect(recordProfileSnapshot).not.toHaveBeenCalled();
    expect(recordAccountUsageSnapshot).not.toHaveBeenCalled();
    expect(accountUsagePersistence.recordInBandSnapshot).not.toHaveBeenCalled();
    expect(updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('rejects a current descriptor observation whose confirmed subject disagrees with the fetched credential', async () => {
    const now = 1_000_000;
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
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
    const foreignSnapshot = {
      v: 1,
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'foreign-acct',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      providerId: 'openai-codex',
      accountSubject: { kind: 'providerSubject', id: 'foreign-acct' },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: 300_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_empty',
      planLabel: null,
      accountLabel: null,
      meters: [],
    } satisfies AgentAccountUsageSnapshot;
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain,
    } as unknown as QuotaApi;
    const fetcher = {
      serviceId: 'openai-codex' as const,
      loadQuota: vi.fn(async () => foreignSnapshot),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      discoveryEnabled: false,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledOnce();
    expect(registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
  });

  it('polls and persists plaintext quotas with token-only account custody', async () => {
    const now = 1_000_000;
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
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
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain,
    } as unknown as QuotaApi;
    const loadQuota = vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
      record,
      now,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [{
        serviceId: 'openai-codex',
        loadQuota,
      }],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      discoveryEnabled: false,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(loadQuota).toHaveBeenCalledOnce();
    expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ t: 'plain' }),
      }),
    );
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(api.getConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
  });

  it('does not let a fresh quota response for another qualified account suppress polling', async () => {
    const now = 1_000_000;
    const profile: QualifiedConnectedAccountProfileV4 = {
      ref: {
        service: {
          pluginId: 'acme.novel.accounts',
          localId: 'work-cloud',
        },
        accountId: 'account-a',
      },
      status: 'connected',
      authenticationModeId: 'manual',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      configurationReady: true,
      configurationRevision: null,
      providerIdentity: { accountId: 'provider-account-a' },
      displayName: 'Novel Work',
      scopes: [],
    };
    const otherRef = {
      ...profile.ref,
      accountId: 'account-b',
    };
    const otherRecordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'acme.novel.accounts/work-cloud',
      accountSubjectId: 'provider-account-b',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const invokeWithReceipt = vi.fn(async () => ({
      result: {
        observedAtMs: now,
        limits: [],
      },
      basis: {
        credentialRevision: profile.credentialRevision,
        credentialConfigurationRevision: null,
        isCurrent: () => true,
      },
    }));
    const readQuota = vi.fn(async () => ({
      ref: otherRef,
      sourceResolution: {
        source: {
          ref: otherRef,
          bindingKind: 'account' as const,
        },
        recordId: buildProviderAccountUsageRecordId(otherRecordKey),
        providerAccountId: otherRecordKey.accountSubjectId,
        fetchedAt: now,
        staleAfterMs: 300_000,
      },
      content: {
        t: 'plain' as const,
        v: {
          v: 1 as const,
          ref: otherRef,
          fetchedAt: now,
          staleAfterMs: 300_000,
          planLabel: null,
          accountLabel: null,
          providerId: otherRecordKey.providerId,
          activeAccountId: otherRecordKey.accountSubjectId,
          fetchedAtMs: now,
          staleAtMs: now + 300_000,
          source: 'provider_api' as const,
          confidence: 'exact' as const,
          meters: [],
        },
      },
      metadata: {
        fetchedAt: now,
        staleAfterMs: 300_000,
        status: 'ok' as const,
      },
    }));
    const writeProviderAccountUsage = vi.fn(async () => ({
      success: true as const,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      accountUsageStore: createProviderAccountUsageStore(),
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4' as const,
        establishedRuntimeOwner: { invokeWithReceipt },
        listScheduledAccounts: vi.fn(async () => [profile]),
        readQuota,
        writeProviderAccountUsage,
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
      quotaPersistenceMinFreshnessMs: 60_000,
    });

    await coordinator.tickOnce();

    expect(readQuota).toHaveBeenCalledWith({
      token: 'happy-token',
      ref: profile.ref,
    });
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
    expect(writeProviderAccountUsage).toHaveBeenCalledOnce();
  });

  it('targets only the requested advertised-v4 group candidates during a pre-turn probe', async () => {
    const now = 1_000_000;
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const profile = {
      ref: { service, accountId: 'backup' },
      status: 'connected',
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      configurationReady: true,
      configurationRevision: null,
      providerIdentity: { accountId: 'provider-backup' },
      displayName: 'Backup',
      scopes: [],
    } satisfies QualifiedConnectedAccountProfileV4;
    const listScheduledAccounts = vi.fn(async () => {
      throw new Error('full scheduled inventory must not be read by pre-turn probes');
    });
    const listGroupQuotaTargets = vi.fn(async () => [{ profile, groupGeneration: 7 }]);
    const invokeWithReceiptCalls: Array<Readonly<{
      account: QualifiedConnectedAccountProfileV4['ref'];
      operation: ConnectedAccountRuntimeEstablishedOperation;
      signal?: AbortSignal;
    }>> = [];
    function invokeWithReceipt<
      TOperation extends ConnectedAccountRuntimeEstablishedOperation,
    >(input: Readonly<{
      account: QualifiedConnectedAccountProfileV4['ref'];
      operation: TOperation;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>): Promise<Readonly<{
      result: ConnectedAccountRuntimeEstablishedResult<TOperation>;
      basis: QualifiedConnectedAccountEstablishedInvocationBasis;
    }>>;
    async function invokeWithReceipt(input: Readonly<{
      account: QualifiedConnectedAccountProfileV4['ref'];
      operation: ConnectedAccountRuntimeEstablishedOperation;
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>): Promise<unknown> {
      invokeWithReceiptCalls.push(input);
      if (input.operation.kind !== 'quota') {
        throw new Error(`unexpected established operation: ${input.operation.kind}`);
      }
      return {
        result: { observedAtMs: now, limits: [] },
        basis: {
          credentialRevision: profile.credentialRevision,
          credentialConfigurationRevision: null,
          runtimeConfigurationRevision: 'configuration-1',
          generation: 'generation-1',
          immutableGenerationId: 'immutable-generation-1',
          isCurrent: () => true,
          prepareCredentialReplacement: () => {
            throw new Error('quota probe must not prepare a credential replacement');
          },
        },
      };
    }
    const accountUsageStore = createProviderAccountUsageStore();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      } satisfies QuotaApi,
      credentials: { token: 'happy-token', encryption: null },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length),
      accountUsageStore,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4' as const,
        establishedRuntimeOwner: { invokeWithReceipt },
        listScheduledAccounts,
        listGroupQuotaTargets,
      },
    });

    await expect(coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    })).resolves.toEqual({
      status: 'complete',
      requestedProfileCount: 1,
      completedProfileCount: 1,
    });
    expect(listGroupQuotaTargets).toHaveBeenCalledWith({
      service,
      groupId: 'team',
      accountIds: ['backup'],
      signal: expect.any(AbortSignal),
    });
    expect(listScheduledAccounts).not.toHaveBeenCalled();
    expect(invokeWithReceiptCalls).toEqual([expect.objectContaining({
      account: profile.ref,
      operation: { kind: 'quota' },
      signal: expect.any(AbortSignal),
    })]);
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    })).not.toBeNull();
  });

  it('does not run any quota transport for revisioned Bitbucket when its generated peer operation set is empty', async () => {
    const now = 1_000_000;
    const service = {
      pluginId: 'happier.scm.forge.bitbucket',
      localId: 'bitbucket-account',
    } as const;
    const snapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          connectedServices: {
            credentialDelete: { revisionGuard: true },
          },
        },
      }),
    };
    const getConnectedServiceCredentialPlain = vi.fn(
      async () => null,
    );
    const getConnectedServiceQuotaSnapshotPlain = vi.fn(
      async () => null,
    );
    const acquireConnectedServiceRefreshLease = vi.fn(
      async () => ({
        acquired: true,
        leaseUntil: now + 30_000,
        ownerId: 'owner',
        credentialRevision:
          'csr_0123456789ABCDEFGHJKMNPQRS',
      }),
    );
    const registerProviderAccountUsageSnapshotPlain = vi.fn(
      async () => undefined,
    );
    const loadQuota = vi.fn(async () => null);
    const invokeWithReceipt = vi.fn();
    const listScheduledAccounts = vi.fn(async () => []);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain,
        getConnectedServiceQuotaSnapshotPlain,
        acquireConnectedServiceRefreshLease,
        registerProviderAccountUsageSnapshotPlain,
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [{
        serviceId: 'bitbucket',
        loadQuota,
      }],
      now: () => now,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'revisioned_v2_v3',
        resolveOperationTransport: ({
          operation,
        }: Readonly<{
          operation: BuiltInLegacyConnectedAccountOperation;
        }>) =>
          resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot,
            serverContract: null,
            service,
            operation,
          }),
        establishedRuntimeOwner: { invokeWithReceipt },
        listScheduledAccounts,
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          bitbucket: {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(listScheduledAccounts).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect(acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(loadQuota).not.toHaveBeenCalled();
    expect(invokeWithReceipt).not.toHaveBeenCalled();
    expect(
      registerProviderAccountUsageSnapshotPlain,
    ).not.toHaveBeenCalled();
  });

  it('does not start a legacy quota fetch after the peer changes while acquiring its lease', async () => {
    const now = 1_000_000;
    let peerClass:
      | 'revisioned_v2_v3'
      | 'advertised_v4' = 'revisioned_v2_v3';
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
    const loadQuota = vi.fn(async () => null);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision:
            'csr_0123456789ABCDEFGHJKMNPQRS',
        })),
        getConnectedServiceQuotaSnapshotPlain:
          vi.fn(async () => null),
        getConnectedServiceQuotaSnapshotSealed:
          vi.fn(async () => null),
        getConnectedServiceCredentialSealed:
          vi.fn(async () => null),
        acquireConnectedServiceRefreshLease: vi.fn(async () => {
          peerClass = 'advertised_v4';
          return {
            acquired: true,
            leaseUntil: now + 30_000,
          };
        }),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        loadQuota,
      }],
      now: () => now,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
      machineIdProvider: () => 'machine-1',
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => peerClass,
        resolveOperationTransport: () =>
          peerClass === 'revisioned_v2_v3'
            ? {
                kind: 'legacy' as const,
                peerClass,
                serviceId: 'openai-codex' as const,
              }
            : { kind: 'v4' as const },
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(),
        },
        listScheduledAccounts: vi.fn(async () => []),
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(loadQuota).not.toHaveBeenCalled();
  });

  it('schedules a novel qualified account through the plugin quota leaf and canonical V4 usage writer', async () => {
    const now = 1_000_000;
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-quota-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-quota-plugin-'));
    const profile: QualifiedConnectedAccountProfileV4 = {
      ref: {
        service: {
          pluginId: 'acme.novel.accounts',
          localId: 'work-cloud',
        },
        accountId: 'account-a',
      },
      status: 'connected',
      authenticationModeId: 'manual',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      configurationReady: true,
      configurationRevision: null,
      providerIdentity: { accountId: 'provider-account-a' },
      displayName: 'Novel Work',
      scopes: [],
    };
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: profile.ref.service.pluginId,
      version: '1.0.0',
      displayName: 'Novel accounts',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        connectedAccountDescriptors: [{
          id: profile.ref.service.localId,
          title: 'Novel account',
          authentication: {
            defaultModeId: 'manual',
            modes: [{
              id: 'manual',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
              }],
            }],
          },
        }],
      },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
      api.connectedAccounts.register('work-cloud', {
        authentication: { modes: { manual: { kind: 'manual', async complete() {
          return { status: 'connected', accountId: 'account-a', scopes: [] };
        } } } },
        async refresh() { return { status: 'unavailable' }; },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async status() { return { status: 'connected' }; },
        async quota(context) {
          const token = await context.credentials.get('token');
          if (token !== 'novel-token') throw new Error('quota credential unavailable');
          return {
            observedAtMs: ${now},
            limits: [{
              id: 'monthly',
              used: 25,
              remaining: 75,
              resetsAtMs: ${now + 60_000}
            }]
          };
        },
        async materialize() { return { kind: 'environment', env: {} }; }
      });
    }`, 'utf8');
    const distribution =
      await createLocalPathPluginDistributionIdentity(pluginRoot);
    await writeCommittedLocalPathPluginFixture({
      happyHomeDir,
      pluginId: profile.ref.service.pluginId,
      sourceRootPath: pluginRoot,
      plugin: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(
            pluginRoot,
            '.happier-plugin',
            'plugin.json',
          ),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          installedPath: null,
          trust: createPluginTrustRecord({
            pluginId: profile.ref.service.pluginId,
            distribution,
            approvedAtMs: 1,
          }),
        },
        state: { enabled: true },
      },
    });
    const runtimeRegistry =
      await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        accountStorageDependencies: createQuotaFixtureAccountStorageDependencies(),
      });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const credentialContent =
      sealQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        payload: {
          v: 1,
          values: { token: 'novel-token' },
        },
        randomBytes: (length) => new Uint8Array(length),
      });
    const readCredential = vi.fn(async () => ({
      ref: profile.ref,
      authenticationModeId: profile.authenticationModeId,
      revisionSemantics: 'revisioned' as const,
      credentialRevision: profile.credentialRevision,
      configurationRevision: profile.configurationRevision,
      content: credentialContent,
      metadata: { scopes: [] },
    }));
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: {
          async acquireRuntimeRegistry() {
            return {
              registry: runtimeRegistry,
              source: 'active' as const,
              durableRevision: runtimeRegistry.durableRevision ?? -1,
              release: async () => undefined,
            };
          },
          isRuntimeRegistryCurrent(candidate) {
            return candidate === runtimeRegistry;
          },
        },
        credentials,
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        configuration: {
          read: vi.fn(async () => null),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const listScheduledAccounts = vi.fn(async () => [profile]);
    const readQuota = vi.fn(async () => null);
    const writeProviderAccountUsage = vi.fn(async () => ({
      success: true as const,
    }));
    const qualifiedConnectedAccountRuntime = {
      resolvePeerClass: () => 'advertised_v4' as const,
      establishedRuntimeOwner,
      listScheduledAccounts,
      readQuota,
      writeProviderAccountUsage,
    } as unknown as QualifiedConnectedAccountQuotaRuntime;
    const accountUsageStore = createProviderAccountUsageStore();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      accountUsageStore,
      qualifiedConnectedAccountRuntime,
      quotaPersistenceMinFreshnessMs: 60_000,
    });

    try {
      await coordinator.tickOnce();

      expect(listScheduledAccounts).toHaveBeenCalledTimes(1);
      expect(readQuota).toHaveBeenCalledWith({
        token: 'happy-token',
        ref: profile.ref,
      });
      expect(readCredential).toHaveBeenCalled();
      expect(
        runtimeRegistry.activatedPluginIds.has(
          profile.ref.service.pluginId,
        ),
      ).toBe(true);
      expect(writeProviderAccountUsage).toHaveBeenCalledWith({
        token: 'happy-token',
        write: expect.objectContaining({
          source: {
            ref: profile.ref,
            bindingKind: 'account',
          },
          expectedCredentialRevision: profile.credentialRevision,
          expectedConfigurationRevision:
            profile.configurationRevision,
          payloadMode: 'plain_json_v1',
          snapshot: expect.objectContaining({
            providerId:
              'acme.novel.accounts/work-cloud',
            accountSubject: {
              kind: 'providerSubject',
              id: 'provider-account-a',
            },
            accountLabel: 'Novel Work',
            meters: [
              expect.objectContaining({
                meterId: 'monthly',
                used: 25,
                remaining: 75,
              }),
            ],
          }),
        }),
      });
      expect(accountUsageStore.listSnapshots()).toEqual([
        expect.objectContaining({
          providerId:
            'acme.novel.accounts/work-cloud',
          accountLabel: 'Novel Work',
        }),
      ]);
    } finally {
      await runtimeRegistry.dispose();
      await Promise.all([
        rm(happyHomeDir, { recursive: true, force: true }),
        rm(pluginRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it.each([
    {
      name: 'Codex',
      serviceId: 'openai-codex' as const,
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
      authenticationModeId: 'oauth',
      peerClass: 'advertised_v4' as const,
      expectedExecutor: 'qualified' as const,
    },
    {
      name: 'Claude setup-token',
      serviceId: 'claude-subscription' as const,
      pluginId: 'happier.agent.claude',
      localId: 'claude-subscription',
      authenticationModeId: 'setup-token',
      peerClass: 'advertised_v4' as const,
      expectedExecutor: 'qualified' as const,
    },
    {
      name: 'Codex legacy peer',
      serviceId: 'openai-codex' as const,
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
      authenticationModeId: 'oauth',
      peerClass: 'revisioned_v2_v3' as const,
      expectedExecutor: 'legacy' as const,
    },
    {
      name: 'Codex indeterminate peer',
      serviceId: 'openai-codex' as const,
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
      authenticationModeId: 'oauth',
      peerClass: 'indeterminate' as const,
      expectedExecutor: 'none' as const,
    },
    {
      name: 'Codex exact v0.2.1 peer',
      serviceId: 'openai-codex' as const,
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
      authenticationModeId: 'oauth',
      peerClass: 'exact_v0_2_1' as const,
      expectedExecutor: 'none' as const,
    },
  ])('routes a mapped $name account through the $expectedExecutor quota executor for peer class $peerClass', async ({
    serviceId,
    pluginId,
    localId,
    authenticationModeId,
    peerClass,
    expectedExecutor,
  }) => {
    const now = 1_000_000;
    const profileId = 'work';
    const credentialRevision =
      'csr_0123456789ABCDEFGHJKMNPQRS';
    const profile: QualifiedConnectedAccountProfileV4 = {
      ref: {
        service: { pluginId, localId },
        accountId: profileId,
      },
      status: 'connected',
      authenticationModeId,
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationReady: true,
      configurationRevision: null,
      providerIdentity: {
        accountId: `provider-${serviceId}`,
      },
      displayName: `${serviceId} work`,
      scopes: [],
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId,
      profileId,
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId:
          profile.providerIdentity?.accountId ?? null,
        providerEmail: null,
      },
    });
    const legacyFetcher: ConnectedServiceQuotaFetcher = {
      serviceId,
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
        planLabel: 'Legacy',
        accountLabel: null,
        meters: [],
      })),
    };
    const invokeWithReceipt = vi.fn(async () => ({
      result: {
        observedAtMs: now,
        limits: [{
          id: 'weekly',
          used: 20,
          remaining: 80,
          resetsAtMs: now + 60_000,
        }],
      },
      basis: {
        credentialRevision,
        credentialConfigurationRevision: null,
        isCurrent: () => true,
      },
    }));
    const writeProviderAccountUsage = vi.fn(
      async () => ({ success: true as const }),
    );
    const qualifiedConnectedAccountRuntime = {
      resolvePeerClass: () => peerClass,
      establishedRuntimeOwner: { invokeWithReceipt },
      listScheduledAccounts: vi.fn(async () => [profile]),
      readQuota: vi.fn(async () => null),
      writeProviderAccountUsage,
    } as unknown as QualifiedConnectedAccountQuotaRuntime;
    const getConnectedServiceCredentialPlain = vi.fn(
      async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      }),
    );
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain:
          vi.fn(async () => null),
        getConnectedServiceQuotaSnapshotSealed:
          vi.fn(async () => null),
        getConnectedServiceCredentialPlain,
        getConnectedServiceCredentialSealed:
          vi.fn(async () => null),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [legacyFetcher],
      now: () => now,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      accountUsageStore: createProviderAccountUsageStore(),
      qualifiedConnectedAccountRuntime,
      quotaPersistenceMinFreshnessMs: 60_000,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          [serviceId]: {
            source: 'connected',
            profileId,
          },
        },
      },
    });

    await coordinator.tickOnce();

    if (expectedExecutor === 'legacy') {
      expect(legacyFetcher.loadQuota).toHaveBeenCalledOnce();
      expect(
        getConnectedServiceCredentialPlain,
      ).toHaveBeenCalledTimes(2);
      expect(invokeWithReceipt).not.toHaveBeenCalled();
      expect(writeProviderAccountUsage).not.toHaveBeenCalled();
    } else if (expectedExecutor === 'qualified') {
      expect(legacyFetcher.loadQuota).not.toHaveBeenCalled();
      expect(
        getConnectedServiceCredentialPlain,
      ).not.toHaveBeenCalled();
      expect(invokeWithReceipt).toHaveBeenCalledWith({
        account: profile.ref,
        operation: { kind: 'quota' },
      });
      expect(writeProviderAccountUsage).toHaveBeenCalledOnce();
    } else {
      expect(legacyFetcher.loadQuota).not.toHaveBeenCalled();
      expect(
        getConnectedServiceCredentialPlain,
      ).not.toHaveBeenCalled();
      expect(invokeWithReceipt).not.toHaveBeenCalled();
      expect(writeProviderAccountUsage).not.toHaveBeenCalled();
    }
  });

  it('opens predecessor-rich V2 quota ciphertext through the legacy boundary codec', () => {
    const secret = new Uint8Array(32).fill(9);
    const payload = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        credits: [{
          providerCreditId: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
          providerResetType: 'five_hour',
        }],
      },
      meters: [],
    };
    const ciphertext =
      sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
      material: { type: 'legacy', secret },
      payload,
      randomBytes: (length) => new Uint8Array(length).fill(6),
      });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      },
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret },
      },
      quotaFetchers: [],
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(6),
    });
    const owner = coordinator as unknown as Readonly<{
      openExistingQuotaSnapshot(input: Readonly<{
        accountMode: 'e2ee';
        existing: SealedQuotaSnapshotResponse;
        material: { type: 'legacy'; secret: Uint8Array };
      }>): ConnectedServiceQuotaSnapshotV1 | null;
    }>;

    expect(owner.openExistingQuotaSnapshot({
      accountMode: 'e2ee',
      existing: {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          fetchedAt: 1_000,
          staleAfterMs: 300_000,
          status: 'ok',
        },
      },
      material: { type: 'legacy', secret },
    })).toMatchObject({
      recoveryCredits: {
        availableCount: 1,
        credits: [{
          id: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
        }],
      },
    });
  });

  it('distinguishes absent quota snapshots from retained corrupt or locked authoritative content', () => {
    const secret = new Uint8Array(32).fill(9);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      },
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret },
      },
      quotaFetchers: [],
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(6),
    });
    const owner = coordinator as unknown as Readonly<{
      openExistingQuotaSnapshot(input: Readonly<{
        accountMode: 'plain' | 'e2ee';
        existing: SealedQuotaSnapshotResponse | Readonly<{
          content: { t: 'plain'; v: unknown };
          metadata: {
            fetchedAt: number;
            staleAfterMs: number;
            status: 'ok';
          };
        }> | null;
        material: { type: 'legacy'; secret: Uint8Array } | null;
      }>): ConnectedServiceQuotaSnapshotV1 | null;
    }>;

    expect(owner.openExistingQuotaSnapshot({
      accountMode: 'plain',
      existing: null,
      material: null,
    })).toBeNull();
    expect(() => owner.openExistingQuotaSnapshot({
      accountMode: 'plain',
      existing: {
        content: { t: 'plain', v: { v: 999 } },
        metadata: {
          fetchedAt: 1_000,
          staleAfterMs: 300_000,
          status: 'ok',
        },
      },
      material: null,
    })).toThrow(expect.objectContaining({
      code: 'connected_service_stored_content_unavailable',
      reason: 'stored_content_corrupt',
      contentKind: 'quota_snapshot',
    }));
    expect(() => owner.openExistingQuotaSnapshot({
      accountMode: 'e2ee',
      existing: {
        sealed: {
          format: 'account_scoped_v1',
          ciphertext: 'retained-e2ee-ciphertext',
        },
        metadata: {
          fetchedAt: 1_000,
          staleAfterMs: 300_000,
          status: 'ok',
        },
      },
      material: null,
    })).toThrow(expect.objectContaining({
      code: 'connected_service_stored_content_unavailable',
      reason: 'encryption_material_unavailable',
      contentKind: 'quota_snapshot',
    }));
    expect(() => owner.openExistingQuotaSnapshot({
      accountMode: 'e2ee',
      existing: {
        sealed: {
          format: 'account_scoped_v1',
          ciphertext: 'authentication-failed-ciphertext',
        },
        metadata: {
          fetchedAt: 1_000,
          staleAfterMs: 300_000,
          status: 'ok',
        },
      },
      material: { type: 'legacy', secret },
    })).toThrow(expect.objectContaining({
      code: 'connected_service_stored_content_unavailable',
      reason: 'stored_content_corrupt',
      contentKind: 'quota_snapshot',
    }));
  });

  it('does not refresh or replace an authoritative stale corrupt quota snapshot', async () => {
    const now = 1_000_000;
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
    const loadQuota = vi.fn(async () => null);
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async (_params: QualifiedProviderAccountUsageWriteArgs) => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: { v: 999 } as unknown as ConnectedServiceQuotaSnapshotV1 },
        metadata: {
          fetchedAt: now - 600_000,
          staleAfterMs: 60_000,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain,
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: { token: 'token-only', encryption: null },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        loadQuota,
      }],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(6),
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });

    await coordinator.tickOnce();

    expect(loadQuota).not.toHaveBeenCalled();
    expect(registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
  });

  it('records request-auth provider backoff in the existing quota binding backoff owner', async () => {
    const recordDiagnostic = vi.fn();
    const getConnectedServiceCredentialPlain = vi.fn(async () => {
      throw new Error('request-auth backoff should suppress credential access');
    });
    const loadQuota = vi.fn(async () => null);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
        getConnectedServiceCredentialPlain,
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        loadQuota,
      }],
      now: () => 10_000,
      randomBytes: (length: number) => new Uint8Array(length),
      failureBackoffJitterPct: 0,
      recordDiagnostic,
    });

    expect(coordinator.recordRequestAuthProviderBackoff({
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'team',
      groupGeneration: 7,
      limitCategory: 'rate_limit',
      quotaScope: 'provider',
      retryAfterMs: 2_500,
      resetAtMs: null,
      providerCode: 'provider_rate_limit',
    })).toEqual({
      status: 'recorded',
      consecutiveFailures: 1,
      nextAllowedAtMs: 12_500,
    });
    expect(recordDiagnostic).toHaveBeenCalledWith({
      event: 'quota_work_suppressed',
      phase: 'probe_group',
      reason: 'request_auth_provider_backoff',
      retryAfterMs: 2_500,
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'work',
      decisionTrace: {
        groupGeneration: 7,
        limitCategory: 'rate_limit',
        quotaScope: 'provider',
        providerCode: 'provider_rate_limit',
        nextAllowedAtMs: 12_500,
      },
    });

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['work'],
    });
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(loadQuota).not.toHaveBeenCalled();
  });

  it('records novel qualified request-auth provider backoff under the scheduled account key', async () => {
    const profile = {
      ref: {
        service: {
          pluginId: 'acme.novel.accounts',
          localId: 'subscription',
        },
        accountId: 'primary',
      },
      status: 'connected',
      authenticationModeId: 'manual',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      configurationReady: true,
      configurationRevision: null,
      displayName: 'Primary',
      scopes: [],
    } satisfies QualifiedConnectedAccountProfileV4;
    const listScheduledAccounts = vi.fn(async () => [profile]);
    const invokeWithReceipt = vi.fn(async () => {
      throw new Error('qualified request-auth backoff should suppress quota invocation');
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => 10_000,
      randomBytes: (length) => new Uint8Array(length),
      failureBackoffJitterPct: 0,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4' as const,
        establishedRuntimeOwner: { invokeWithReceipt },
        listScheduledAccounts,
      },
    });

    expect(coordinator.recordQualifiedRequestAuthProviderBackoff({
      account: profile.ref,
      groupId: null,
      groupGeneration: null,
      limitCategory: 'rate_limit',
      quotaScope: 'provider',
      retryAfterMs: 2_500,
      resetAtMs: null,
      providerCode: 'provider_rate_limit',
    })).toEqual({
      status: 'recorded',
      consecutiveFailures: 1,
      nextAllowedAtMs: 12_500,
    });

    await coordinator.tickOnce();

    expect(listScheduledAccounts).toHaveBeenCalledOnce();
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('uses one aggregate probe deadline and starts no later profile work after it expires', async () => {
    vi.useFakeTimers();
    const startedProfileIds: string[] = [];
    const abortedProfileIds: string[] = [];
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId, signal }: { profileId: string; signal?: AbortSignal }) => {
        startedProfileIds.push(profileId);
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            abortedProfileIds.push(profileId);
            reject(signal.reason);
          }, { once: true });
        });
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const loadQuota = vi.fn(async () => null);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [{ serviceId: 'openai-codex', loadQuota }],
      now: () => Date.now(),
      randomBytes: (length: number) => new Uint8Array(length),
      fetchTimeoutMs: 50,
      discoveryEnabled: false,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    });

    const probe = coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary', 'backup'],
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(probe).resolves.toEqual({
      status: 'incomplete',
      requestedProfileCount: 2,
      completedProfileCount: 0,
      reason: 'deadline_exceeded',
    });
    expect(startedProfileIds).toEqual(['primary']);
    expect(abortedProfileIds).toEqual(['primary']);
    expect(loadQuota).not.toHaveBeenCalled();
  });

  function createJwtWithSub(sub: string, marker: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub, marker })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches and uploads plaintext quota snapshots for plaintext accounts', async () => {
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
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      content: {
        t: 'plain',
        v: expect.objectContaining({
          providerId: 'openai-codex',
          planLabel: 'Pro',
          accountLabel: 'user@example.com',
        }),
      },
      metadata: expect.objectContaining({
        fetchedAt: now,
        staleAfterMs: 300_000,
        status: 'ok',
      }),
    }));
    expect((api as any).registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(0);
  });

  it.each([
    [
      'legacy-unfenced',
      {
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
      },
    ],
    ['missing revision semantics', {}],
  ] as const)(
    'keeps %s credentials out of quota fetch and persistence authority',
    async (_case, revisionBoundary) => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const registerProviderAccountUsageSnapshotPlain = vi.fn();
    const getConnectedServiceQuotaSnapshotPlain = vi.fn(async () => null);
    const acquireConnectedServiceRefreshLease = vi.fn(async () => ({
      acquired: true,
      leaseUntil: now + 30_000,
    }));
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain,
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          ...revisionBoundary,
        })),
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
        registerProviderAccountUsageSnapshotPlain,
        registerProviderAccountUsageSnapshotSealed: vi.fn(),
        acquireConnectedServiceRefreshLease,
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      machineIdProvider: () => 'machine-1',
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).not.toHaveBeenCalled();
    expect(registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
    expect(getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect(acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    },
  );

  it('consumes recovery credits through the quota fetcher and persists a refreshed plaintext snapshot', async () => {
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
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const refreshedSnapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now: now + 1,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      recoveryCredits: {
        availableCount: 0,
        credits: [],
      },
      meters: [],
    });
    const consumeRecoveryCredit = vi.fn(async () => 'consumed' as const);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit,
      loadQuota: vi.fn(async () => refreshedSnapshot),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    const result = await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
    });
    const replayed = await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
    });

    expect(result).toEqual({
      ok: true,
      receipt: {
        idempotencyKey: 'consume:work:credit-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: refreshedSnapshot.fetchedAtMs,
        recoveryCredits: refreshedSnapshot.recoveryCredits,
      }),
    });
    expect(replayed).toEqual(result);
    expect(consumeRecoveryCredit).toHaveBeenCalledTimes(1);
    expect(consumeRecoveryCredit).toHaveBeenCalledWith(expect.objectContaining({
      record,
      now,
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
      signal: expect.any(AbortSignal),
    }));
    expect(fetcher.loadQuota).toHaveBeenCalledWith(expect.objectContaining({
      record,
      now,
      signal: expect.any(AbortSignal),
    }));
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      content: {
        t: 'plain',
        v: expect.objectContaining({
          providerId: 'openai-codex',
          recoveryCredits: refreshedSnapshot.recoveryCredits,
        }),
      },
      metadata: expect.objectContaining({
        fetchedAt: refreshedSnapshot.fetchedAtMs,
        staleAfterMs: refreshedSnapshot.staleAfterMs,
        status: 'ok',
      }),
    }));
  });

  it('does not consume a recovery credit after the peer changes while resolving its credential', async () => {
    const now = 1_000_000;
    let peerClass:
      | 'revisioned_v2_v3'
      | 'advertised_v4' = 'revisioned_v2_v3';
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
    const consumeRecoveryCredit = vi.fn(
      async () => 'consumed' as const,
    );
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => {
          peerClass = 'advertised_v4';
          return {
            content: { t: 'plain' as const, v: record },
            revisionSemantics: 'revisioned' as const,
            credentialRevision:
              'csr_0123456789ABCDEFGHJKMNPQRS',
          };
        }),
        getConnectedServiceQuotaSnapshotPlain:
          vi.fn(async () => null),
        getConnectedServiceQuotaSnapshotSealed:
          vi.fn(async () => null),
        getConnectedServiceCredentialSealed:
          vi.fn(async () => null),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        consumeRecoveryCredit,
        loadQuota: vi.fn(async () => null),
      }],
      now: () => now,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => peerClass,
        resolveOperationTransport: () =>
          peerClass === 'revisioned_v2_v3'
            ? {
                kind: 'legacy' as const,
                peerClass,
                serviceId: 'openai-codex' as const,
              }
            : { kind: 'v4' as const },
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(),
        },
        listScheduledAccounts: vi.fn(async () => []),
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });

    await expect(
      coordinator.consumeRecoveryCreditForProfile({
        serviceId: 'openai-codex',
        profileId: 'work',
        idempotencyKey: 'consume:work:credit-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode:
        'connected_service_quota_recovery_credit_unavailable',
    });
    expect(consumeRecoveryCredit).not.toHaveBeenCalled();
  });

  it.each([
    ['consumed', 'consumed'],
    ['already_consumed', 'already_consumed'],
    ['not_available', 'not_available'],
    ['nothing_to_reset', 'nothing_to_reset'],
  ] as const)('preserves the %s recovery-credit outcome in the receipt', async (outcome, expectedStatus) => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit: vi.fn(async () => outcome),
      loadQuota: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [fetcher], now: () => now, randomBytes: (length: number) => randomBytes(length),
    });

    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex', profileId: 'work', idempotencyKey: `req-${outcome}`,
    })).resolves.toEqual(expect.objectContaining({
      receipt: { idempotencyKey: `req-${outcome}`, status: expectedStatus },
    }));
  });

  it('fails closed when the provider returns no recovery-credit outcome', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher = {
      serviceId: 'openai-codex', consumeRecoveryCredit: vi.fn(async () => undefined), loadQuota: vi.fn(async () => null),
    } as unknown as ConnectedServiceQuotaFetcher;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [fetcher], now: () => now, randomBytes: (length: number) => randomBytes(length),
    });
    await expect(coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex', profileId: 'work', idempotencyKey: 'req-void',
    })).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  it('keeps the consume receipt idempotent when refresh persistence fails after the provider spend', async () => {
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {
        throw new Error('persist failed');
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const refreshedSnapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now: now + 1,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      recoveryCredits: {
        availableCount: 0,
        credits: [],
      },
      meters: [],
    });
    const consumeRecoveryCredit = vi.fn(async () => 'consumed' as const);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      consumeRecoveryCredit,
      loadQuota: vi.fn(async () => refreshedSnapshot),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    const result = await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
    });
    const replayed = await coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'connected_service_quota_recovery_credit_failed',
      receipt: {
        idempotencyKey: 'consume:work:credit-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
    });
    expect(replayed).toEqual(result);
    expect(consumeRecoveryCredit).toHaveBeenCalledTimes(1);
  });

  it('does not issue a queued legacy persistence write after the peer changes', async () => {
    const now = 1_000_000;
    let peerClass:
      | 'revisioned_v2_v3'
      | 'advertised_v4' = 'revisioned_v2_v3';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
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
    const refreshedSnapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now: now + 1,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [],
    });
    const registerProviderAccountUsageSnapshotPlain =
      vi.fn(async () => {});
    const budget = createDaemonServerWorkBudget({
      maxConcurrentWrites: 1,
    });
    let releaseBlocker!: () => void;
    const blocker = budget.run(
      { purpose: 'connectedServiceQuotaPersistence' },
      async () => await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      }),
    );
    await vi.waitFor(() => {
      expect(budget.getSnapshot().activeCount).toBe(1);
    });
    const serverWorkScheduler = createDaemonServerWorkScheduler({
      budget,
      now: () => now,
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision:
            'csr_0123456789ABCDEFGHJKMNPQRS',
        })),
        getConnectedServiceQuotaSnapshotPlain:
          vi.fn(async () => null),
        getConnectedServiceQuotaSnapshotSealed:
          vi.fn(async () => null),
        getConnectedServiceCredentialSealed:
          vi.fn(async () => null),
        registerProviderAccountUsageSnapshotPlain,
      } as unknown as QuotaApi,
      credentials,
      quotaFetchers: [{
        serviceId: 'openai-codex',
        consumeRecoveryCredit:
          vi.fn(async () => 'consumed' as const),
        loadQuota:
          vi.fn(async () => refreshedSnapshot),
      }],
      now: () => now,
      randomBytes: (length: number) =>
        randomBytes(length),
      discoveryEnabled: false,
      serverWorkScheduler,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => peerClass,
        resolveOperationTransport: () =>
          peerClass === 'revisioned_v2_v3'
            ? {
                kind: 'legacy' as const,
                peerClass,
                serviceId: 'openai-codex' as const,
              }
            : { kind: 'v4' as const },
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(),
        },
        listScheduledAccounts: vi.fn(async () => []),
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });

    const consume = coordinator.consumeRecoveryCreditForProfile({
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:work:credit-1',
    });
    await vi.waitFor(() => {
      expect(budget.getSnapshot().queuedCount).toBe(1);
    });
    peerClass = 'advertised_v4';
    releaseBlocker();
    await blocker;

    await expect(consume).resolves.toMatchObject({
      ok: false,
      errorCode:
        'connected_service_quota_recovery_credit_failed',
      receipt: {
        idempotencyKey: 'consume:work:credit-1',
        status: 'consumed',
      },
    });
    expect(
      registerProviderAccountUsageSnapshotPlain,
    ).not.toHaveBeenCalled();
  });

  it('defers in-band durable persistence while account mode is unknown', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'unknown' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    const result = await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });

    expect(result).toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await (coordinator as any).flushInBandQuotaPersistence(100);
  });

  it('suppresses in-band quota snapshots whose embedded service id does not match the write key', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      runtimeQuotaSnapshots,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'suppressed', reason: 'service_id_mismatch' });
    await coordinator.flushInBandQuotaPersistence(1_000);
    expect(runtimeQuotaSnapshots.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      capturedAtMs: now,
    }).size).toBe(0);
  });

  it('suppresses unchanged in-band quota snapshots after the cadence window when the material is identical', async () => {
    let now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const firstFetchedAt = now;
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
      snapshot: makeSnapshot(firstFetchedAt),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    now += 6_000;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(firstFetchedAt),
    })).resolves.toEqual({ status: 'suppressed', reason: 'unchanged_fresh' });
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => null),
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
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
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

    credentials.token = createJwtWithSub('quota-account', 'hydrated');
    now += 1_000;

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
  });

  it('does not pause same-fingerprint in-band persistence after account mode recovers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const now = 1_000_000;
    let modeUnavailable = true;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        if (modeUnavailable) throw new Error('mode unavailable');
        return 'plain' as const;
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 0,
      quotaPersistenceFailureBackoffBaseMs: 10,
      quotaPersistenceFailureBackoffMaxMs: 10,
      quotaPersistenceFailureBackoffJitterRatio: 0,
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
    const resumed = await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot,
    });
    expect(resumed.status).toBe('enqueued');
    const recoveryFlush = coordinator.flushInBandQuotaPersistence(100);
    await vi.advanceTimersByTimeAsync(100);
    await recoveryFlush;

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('refreshes account mode at in-band flush time before choosing quota storage mode', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn()
        .mockResolvedValueOnce('plain' as const)
        .mockResolvedValueOnce('e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    await expect(resolveConnectedServiceAccountMode(api)).resolves.toBe('plain');

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
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
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      },
    });

    await (coordinator as any).flushInBandQuotaPersistence(100);

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalledTimes(2);
    expect((api as any).registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(0);
  });

  it('does not double-count server-work retries for failed in-band quota writes', async () => {
    const now = 1_000_000;
    const serverWorkScheduler = createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      now: () => now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {
        throw createHttpStatusError(503, 'server unavailable');
      }),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      serverWorkScheduler,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });

    await (coordinator as any).flushInBandQuotaPersistence(100);

    expect(serverWorkScheduler.getSnapshot().purposes.connectedServiceQuotaPersistence.counters).toMatchObject({
      accepted: 1,
      failed: 1,
      retried: 1,
    });
  });

  it('coalesces in-band quota snapshots and writes the latest payload on flush', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 5_000,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });
    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now + 1,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      },
    });

    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(0);
    await (coordinator as any).flushInBandQuotaPersistence(100);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
    expect((api as any).registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      content: {
        t: 'plain',
        v: expect.objectContaining({ fetchedAtMs: now + 1, planLabel: 'Pro' }),
      },
      metadata: expect.objectContaining({ materialFingerprint: expect.any(String) }),
    }));
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    expect(fetcher.loadQuota).not.toHaveBeenCalled();
  });

  it('routes polling quota snapshot writes through canonical account usage persistence', async () => {
    let now = 1_000_000;
    const fetchedAt = now;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000_000,
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const accountUsageStore = createProviderAccountUsageStore();
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };
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
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['serverWorkScheduler']>;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now: fetchedAt,
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
      serverWorkScheduler,
      accountUsageStore,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    now += 3_600_000;
    await coordinator.tickOnce();

    expect(accountUsagePersistence.recordInBandSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-codex',
        planLabel: 'Pro',
      }),
      {
        sources: [
          {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
          },
        ],
      },
    );
    expect(accountUsageStore.listSnapshots()).toHaveLength(1);
    expect(serverWorkScheduler.enqueue).not.toHaveBeenCalled();
  });

  it('retries an unchanged account-usage snapshot after revisioned route availability recovers', async () => {
    let now = 1_000_000;
    let routeAvailability: 'available' | 'absent' = 'absent';
    const fetchedAt = now;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000_000,
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
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision:
          'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
          features: {},
          capabilities: {
            connectedServices: {
              credentialDelete: { revisionGuard: true },
            },
          },
        }),
      })),
      getProviderAccountUsageWriteRouteAvailability:
        vi.fn(async () => routeAvailability),
      registerProviderAccountUsageSnapshotPlain,
    };
    const accountUsagePersistence =
      createProviderAccountUsagePersistenceScheduler({
        api,
        now: () => now,
        credentials,
        minFreshnessMs: 0,
      });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({
        record: inputRecord,
      }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now: fetchedAt,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: api as unknown as QuotaApi,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      accountUsageStore: createProviderAccountUsageStore(),
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    try {
      await coordinator.tickOnce();
      await accountUsagePersistence.flush(1_000);
      expect(
        registerProviderAccountUsageSnapshotPlain,
      ).not.toHaveBeenCalled();

      routeAvailability = 'available';
      now += 3_600_000;
      await coordinator.tickOnce();
      await accountUsagePersistence.flush(1_000);

      expect(
        registerProviderAccountUsageSnapshotPlain,
      ).toHaveBeenCalledOnce();
    } finally {
      accountUsagePersistence.dispose();
    }
  });

  it('does not retry persistence for an older account-usage observation', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000_000,
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
    const olderSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [],
    };
    const accountUsageStore = createProviderAccountUsageStore();
    const newerUsage =
      buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: {
          ...olderSnapshot,
          fetchedAt: now + 1,
        },
        observedAtMs: now + 1,
        sourceProviderAccountId: 'acct',
      });
    accountUsageStore.recordSnapshot(newerUsage, {
      sources: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      }],
    });
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({
        status: 'enqueued' as const,
        enqueue: 'accepted' as const,
      })),
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision:
            'csr_0123456789ABCDEFGHJKMNPQRS',
        })),
        getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      } as unknown as QuotaApi,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      accountUsageStore,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(accountUsageStore.listSnapshots()).toEqual([newerUsage]);
    expect(
      accountUsagePersistence.recordInBandSnapshot,
    ).not.toHaveBeenCalled();
  });

  it('records fetched quota snapshots under the credential provider account when the provider omits active account id', async () => {
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
        providerAccountId: 'credential-provider-account',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const accountUsageStore = createProviderAccountUsageStore();
    const accountUsagePersistence = {
      recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
      accountUsageStore,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(accountUsagePersistence.recordInBandSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-codex',
        accountSubject: { kind: 'providerSubject', id: 'credential-provider-account' },
        recordKey: expect.objectContaining({
          accountSubjectId: 'credential-provider-account',
          subjectKind: 'account',
        }),
      }),
      {
        sources: [
          {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
          },
        ],
      },
    );
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    let uploadedCiphertext: string | null = null;
    let uploadedStatus: string | null = null;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploadedCiphertext = readSealedQualifiedProviderAccountUsageCiphertext(params);
        uploadedStatus = params.write.status;
      }),
    };

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');
    expect(uploadedStatus).toBe('ok');

    const opened = openProviderAccountUsageSnapshotCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: uploadedCiphertext ?? '',
    });
    expect(opened?.value).toBeTruthy();
    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(opened?.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.providerId).toBe('openai-codex');
      expect(projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
        snapshot: parsed.data,
        source: {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'profile',
        },
      })).toEqual(expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }));
    }
  });

  it('rejects sealed quota usage when the fetched provider account differs from the credential profile', async () => {
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const uploads: QualifiedProviderAccountUsageWriteArgs[] = [];
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploads.push(params);
      }),
    };

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
        providerId: 'codex',
        accountSubjectId: 'acct-observed-provider',
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

    expect(api.registerProviderAccountUsageSnapshotSealed).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  });

  it('does not source-link provider-account usage without proven source provider identity', async () => {
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
        providerAccountId: null,
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const uploads: QualifiedProviderAccountUsageWriteArgs[] = [];
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploads.push(params);
      }),
    };

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
        providerId: 'codex',
        accountSubjectId: 'acct-observed-provider',
        subjectKind: 'unknown',
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
    const uploaded = uploads[0];
    expect(uploaded).toBeDefined();
    if (!uploaded) throw new Error('expected uploaded provider usage snapshot');
    expect(uploaded.write.recordKey.subjectKind).toBe('unknown');
    expect(uploaded.write.source.bindingKind).toBe('account');
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
          policy: {},
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(fetcher.loadQuota).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    }));
  });

  it('asks the auth-group switch coordinator to re-evaluate an active group after refreshing its active profile quota', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
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

  it('uses canonical account usage instead of stale legacy runtime quota snapshots for proactive soft switching', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
    const accountUsageStore = createProviderAccountUsageStore();
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'active',
        now,
        remainingPct: 90,
        groupGeneration: 1,
      }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'active', groupGeneration: 1 }),
    );
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 5,
        groupGeneration: 1,
      }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup', groupGeneration: 1 }),
    );

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      recordDiagnostic: (event: unknown) => diagnostics.push(event),
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
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

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledOnce();
  });

  it('reactively requests a soft switch only on an explicitly in-band usage change', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({ serviceId: 'openai-codex', now });
    const accountUsageStore = createProviderAccountUsageStore();
    // Active member has burned below the soft-switch threshold (15%); backup is healthy → eligible.
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'active', now, remainingPct: 5, groupGeneration: 1 }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'active', groupGeneration: 1 }),
    );
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'backup', now, remainingPct: 90, groupGeneration: 1 }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup', groupGeneration: 1 }),
    );
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
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' } },
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

    const change = {
      sessionId: 'session-1',
      serviceId: 'openai-codex' as const,
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      recordId: buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'active', now, remainingPct: 5, groupGeneration: 1 }).recordId,
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'active', now, remainingPct: 5, groupGeneration: 1 }),
    };

    // Poll-sourced change must NOT reactively re-request the switch (the poll runs its own check).
    await coordinator.handleAccountUsageChanged({ ...change, source: 'poll' });
    expect(switchBeforeTurn).not.toHaveBeenCalled();

    // Missing or future source classifications must fail closed instead of inheriting predictive
    // switch authority.
    await coordinator.handleAccountUsageChanged(change);
    expect(switchBeforeTurn).not.toHaveBeenCalled();

    // Genuine in-band change reactively requests the soft switch, closing the poll-latency gap.
    await coordinator.handleAccountUsageChanged({ ...change, source: 'in_band' });
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });

    // A quota read caused by an already-surfaced hard limit is evidence for the hard-recovery
    // owner, not a second predictive switch request.
    await coordinator.handleAccountUsageChanged({ ...change, source: 'evidence_only' });
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(diagnostics).toContainEqual({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'post_hard_limit_snapshot_evidence_only',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'active',
    });
  });

  it('uses canonical group truth when an in-band sibling still reports a predecessor profile', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now,
      memberProfileIds: ['stale-predecessor'],
    });
    const accountUsageStore = createProviderAccountUsageStore();
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'active',
        now,
        remainingPct: 5,
        groupGeneration: 1,
      }),
      buildConnectedGroupProviderAccountUsageObservation({
        profileId: 'active',
        groupGeneration: 1,
      }),
    );
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 90,
        groupGeneration: 1,
      }),
      buildConnectedGroupProviderAccountUsageObservation({
        profileId: 'backup',
        groupGeneration: 1,
      }),
    );
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
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
      accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    const staleSnapshot = buildConnectedGroupProviderAccountUsageSnapshot({
      profileId: 'stale-predecessor',
      now,
      remainingPct: 90,
      groupGeneration: 1,
    });
    await coordinator.handleAccountUsageChanged({
      sessionId: 'stale-sibling',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'stale-predecessor',
      groupGeneration: 1,
      recordId: staleSnapshot.recordId,
      snapshot: staleSnapshot,
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

  it('marks a burn-projected in-band soft switch as sourceProjected in diagnostics (PS-1)', async () => {
    const now = 1_000_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({ serviceId: 'openai-codex', now });
    // Seed a DECREASING-remaining runtime burn history for the active member so the poll-latency-blind
    // predictive projection can see it: 60% → 40% over 100s ⇒ 0.0002 %/ms burn velocity.
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex', profileId: 'active', now: now - 100_000, remainingPct: 60, resetsAt: now + 600_000,
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
    const accountUsageStore = createProviderAccountUsageStore();
    // Active is ABOVE the 15% soft threshold (40%): a reactive/observed check would NOT switch. Only the
    // burn projection (40% − 0.0002 %/ms × 300000ms horizon ⇒ below 0) trips it — a PREEMPTIVE switch.
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'active', now, remainingPct: 40, resetAtMs: now + 600_000, groupGeneration: 1,
      }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'active', groupGeneration: 1 }),
    );
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'backup', now, remainingPct: 90, groupGeneration: 1 }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup', groupGeneration: 1 }),
    );
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
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' } },
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

    const activeSnapshot = buildConnectedGroupProviderAccountUsageSnapshot({ profileId: 'active', now, remainingPct: 40, groupGeneration: 1 });
    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      recordId: activeSnapshot.recordId,
      snapshot: activeSnapshot,
      source: 'in_band',
    });

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    // PS-1: a burn-projection switch must be distinguishable from a reactive one in diagnostics.
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
    const resetAtMs = burnObservedAt + 600_000;
    const softSwitchEligibility = createSoftSwitchEligibilityFixture({
      serviceId: 'openai-codex',
      now: canonicalObservedAt,
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex', profileId: 'active', now: burnObservedAt - 30_000,
        remainingPct: 60, resetsAt: resetAtMs,
      }),
    });
    softSwitchEligibility.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex', groupId: 'team', profileId: 'active', groupGeneration: 1,
      snapshot: buildQuotaSnapshotFixture({
        serviceId: 'openai-codex', profileId: 'active', now: burnObservedAt,
        remainingPct: 40, resetsAt: resetAtMs,
      }),
    });

    const replenishedUsage = buildConnectedGroupProviderAccountUsageSnapshot({
      profileId: 'active',
      groupGeneration: 1,
      now: canonicalObservedAt,
      remainingPct: 100,
      resetAtMs,
    });
    softSwitchEligibility.accountUsageStore.recordSnapshot(
      replenishedUsage,
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'active', groupGeneration: 1 }),
    );
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
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    });

    await coordinator.handleAccountUsageChanged({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
      groupGeneration: 1,
      recordId: replenishedUsage.recordId,
      snapshot: replenishedUsage,
      source: 'in_band',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('leaves generation-qualified target evidence evaluation to the authoritative coordinator', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const accountUsageStore = createProviderAccountUsageStore();
    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 90,
        resetAtMs: now + 600_000,
      }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup' }),
    );
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
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

  it('delegates no-eligible-member decisions to the authoritative coordinator', async () => {
    let now = 1_000_000;
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const accountUsageStore = createProviderAccountUsageStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
    recordGroupMemberAccountUsageFixture(accountUsageStore, {
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 0,
        resetAtMs,
        groupGeneration: 1,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 10,
        resetAtMs,
        groupGeneration: 1,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 90,
        resetAtMs: now + 600_000,
        groupGeneration: 1,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
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
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 75,
        resetAtMs,
        groupGeneration: 1,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
      snapshot: buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now,
        remainingPct: 75,
        resetAtMs,
        groupGeneration: 1,
      }),
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      groupGeneration: 1,
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    const record = buildConnectedServiceCredentialRecord({
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
    const getConnectedServiceAuthGroup = vi.fn(async () => {
      throw new Error('timeout of 5000ms exceeded');
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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

    expect(getConnectedServiceAuthGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'team',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_target_eligibility_unknown',
    });
  });

  it('suppresses proactive soft-threshold switching when runtime quota evidence is unhydrated', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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
    expect(recordDiagnostic).toHaveBeenCalledWith({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_target_eligibility_unknown',
    });
  });

  it('dedupes active-group soft switch cadence by group and active profile across sessions', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
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
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 60_000,
    });
    const target = (pid: number, sessionId: string) => ({
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
    } as const);

    coordinator.registerSpawnTarget(target(123, 'session-1'));
    await coordinator.tickOnce();
    coordinator.registerSpawnTarget(target(124, 'session-2'));
    now += 1_000;
    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
  });

  it('does not require per-session recovery permission for the canonical proactive group switch', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
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
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots: softSwitchEligibility.runtimeQuotaSnapshots,
      accountUsageStore: softSwitchEligibility.accountUsageStore,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'spawn-request-session',
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
    coordinator.updateSpawnTargetSessionId({
      pid: 123,
      sessionId: 'canonical-session-1',
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledOnce();
  });

  it('does not request active-group soft switching while the quota work gate is closed', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
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
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      quotaWorkGate: () => ({ status: 'suppressed' as const, reason: 'local_server_storm' }),
      recordDiagnostic,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      quotaWorkGate: () => { status: 'suppressed'; reason: string };
      recordDiagnostic: (event: unknown) => void;
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
      reason: 'local_server_storm',
    }));
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

    const record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {
        throw new Error('server timeout');
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: softSwitchEligibility.getConnectedServiceAuthGroup,
    } as unknown as QuotaApi;

    const snapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now,
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
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => snapshot),
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
    })).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'active',
      fetchedAt: snapshot.fetchedAtMs,
    }));
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('hot-applies only sibling sessions proven on the same live provider account after account exhaustion', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'same-account') {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-a',
          accountLabel: null,
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      if (sessionId === 'different-account') {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-b',
          accountLabel: null,
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      return { status: 'inexact' as const, reason: 'runtime_identity_probe_inexact' };
    });
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async ({ agentId }: Readonly<{ agentId?: string | null }>): Promise<SameAccountFanoutStrategy> =>
        agentId === 'codex' ? 'provider_account_id' : 'none',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: (input: Readonly<{ agentId?: string | null }>) => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    const registerGroupSession = (sessionId: string, pid: number) => {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'runtime_identity_probe_account_mismatch',
      sessionId: 'different-account',
      expectedProviderAccountId: 'acct-a',
      actualProviderAccountId: 'acct-b',
      expectedProfileId: 'primary',
      actualProfileId: 'primary',
      expectedGroupId: 'team',
      actualGroupId: 'team',
      expectedGroupGeneration: 4,
      actualGroupGeneration: 4,
    }));
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    }));
  });

  it('fans out runtime usage-limit reports through the supplied exact source account after the source session has switched', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'same-account') {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-source',
          accountLabel: 'source@example.test',
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      return {
        status: 'exact' as const,
        providerAccountId: 'acct-other',
        accountLabel: null,
        profileId: 'primary',
        groupId: 'team',
        groupGeneration: 4,
        observedAtMs: now,
        inProviderTurn: false,
        safeToApply: true,
      };
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    const registerGroupSession = (sessionId: string, pid: number, activeProfileId: string) => {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
            generation: 4,
          }]),
        },
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    };
    registerGroupSession('source', 201, 'backup');
    registerGroupSession('same-account', 202, 'primary');
    registerGroupSession('different-account', 203, 'primary');

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      sourceProviderAccountId: 'acct-source',
      sourceAccountLabel: 'source@example.test',
      resetAtMs: null,
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    }));
  });

  it('fans out from an exact indexed same-account identity when no live identity reader is available', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout: null,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
    }) as RuntimeIdentityFanoutCoordinator;
    const registerGroupSession = (sessionId: string, pid: number) => {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    };
    registerGroupSession('source', 251);
    registerGroupSession('same-account', 252);
    registerGroupSession('different-account', 253);
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
    coordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: 'different-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-b',
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

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_no_live_identity',
    }));
  });

  it('does not fan out from a cached same-account identity without a fresh exact runtime proof', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'inexact' as const,
      reason: 'runtime_identity_probe_inexact',
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;

    for (const [sessionId, pid] of [['source', 301], ['same-account', 302]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
      fanoutCandidates: 0,
      fanoutRequests: 0,
    });

    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    }));
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      reason: 'runtime_identity_probe_inexact',
    }));
  });

  it('reconciles a cold same-account sibling from persisted materialization identity when the live probe cannot verify', async () => {
    // Live incident 2026-07-10 18:09: after a daemon restart the in-memory runtime identity index is
    // cold and the live probe frequently cannot answer (busy/unsupported), starving same-account
    // fanout to ZERO. When the probe is UNAVAILABLE/INEXACT (never a verified mismatch), the
    // candidate's PERSISTED materialization identity + persisted credential provider-account id prove
    // same-account membership durably, so the sibling still fans out and the index re-warms.
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'inexact' as const,
      reason: 'runtime_identity_probe_inexact',
    }));
    const readPersistedSessionAccountIdentity = vi.fn(async () => ({
      providerAccountId: 'acct-a',
      serviceId: 'openai-codex' as const,
      groupId: 'team',
      profileId: 'primary',
      groupGeneration: 4,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      readPersistedSessionAccountIdentity,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
      readPersistedSessionAccountIdentity: typeof readPersistedSessionAccountIdentity;
    }) as RuntimeIdentityFanoutCoordinator;

    for (const [sessionId, pid] of [['source', 311], ['same-account', 312]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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

    expect(readPersistedSessionAccountIdentity).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      expectedGroupGeneration: 4,
    }));
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_retained_via_persisted_materialization_identity',
    }));
  });

  it('reconciles cold active same-group sibling identity before declaring no same-account fanout target', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'same-account-cold') {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-a',
          accountLabel: null,
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      if (sessionId === 'different-account-cold') {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-b',
          accountLabel: null,
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      return { status: 'inexact' as const, reason: 'runtime_identity_probe_inexact' };
    });
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    const registerGroupSession = (sessionId: string, pid: number, groupId = 'team') => {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    };
    registerGroupSession('source', 501);
    registerGroupSession('same-account-cold', 502);
    registerGroupSession('different-account-cold', 503);
    registerGroupSession('same-account-other-group', 504, 'other-team');

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

    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledTimes(2);
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account-cold',
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    }));
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'different-account-cold',
    }));
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_no_matching_sessions',
    }));
  });

  it('uses exact runtime account proof before rejecting stale expected profile and generation', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 9, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'runtime-primary',
      groupId: 'team',
      groupGeneration: 8,
      observedAtMs: now,
      inProviderTurn: false,
      safeToApply: true,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;

    for (const [sessionId, pid] of [['source', 701], ['stale-sibling', 702]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
            activeProfileId: 'stale-primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'stale-primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_candidate_stale_generation',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_account_fanout_no_matching_sessions',
    }));
  });

  it('hot-applies a cold sibling only after the host proves its exhausted account identity', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 5, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: true,
      safeToApply: false,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 601], ['busy-sibling', 602]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reason: 'same_provider_account_exhaustion_restart_required',
    }));
  });

  it('does not let quota fanout defer a committed busy-runtime generation', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'deferred' as const, reason: 'defer_until_turn_boundary' }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: true,
      safeToApply: false,
      safeToDirectLiveApply: true,
      requiresTurnBoundaryForApply: false,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 651], ['busy-sibling', 652]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'unsupported-provider',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
  });

  it('does not create a quota-local turn-boundary deferral when provider capability is unavailable', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'deferred' as const, reason: 'defer_until_turn_boundary' }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: true,
      safeToApply: false,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 701], ['busy-sibling', 702]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'turn-boundary-agent',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
  });

  it('does not create a quota-local turn-boundary deferral when runtime apply fields are absent', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'deferred' as const, reason: 'defer_until_turn_boundary' }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      strategy: 'provider_account_id' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: true,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 801], ['busy-sibling', 802]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'turn-boundary-agent',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_candidate_deferred_until_turn_boundary',
    }));
  });

  it('does not re-enter eligibility selection after the source commits a hard-limit generation', async () => {
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
      status: 'no_eligible_member' as const,
      generation: 5,
      groupExhausted: true as const,
      retryAtMs: now + 5_000,
      excluded: [
        { profileId: 'backup', reason: 'quota_exhausted', retryAtMs: now + 5_000 },
      ],
    }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      strategy: 'provider_account_id' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: false,
    }));
    const diagnostics: unknown[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
      recordDiagnostic: (event) => diagnostics.push(event),
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 851], ['idle-sibling', 852]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: now + 5_000,
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
      reason: 'same_provider_account_exhaustion_restart_required',
    }));
  });

  it('emits quota lifecycle transitions from canonical account-usage changes', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const resetAtMs = now + 600_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const accountUsageStore = createProviderAccountUsageStore();
    const primaryBlocked = buildConnectedGroupProviderAccountUsageSnapshot({
      profileId: 'primary',
      now,
      remainingPct: 0,
      resetAtMs,
      groupGeneration: 4,
    });
    const backupBlocked = buildConnectedGroupProviderAccountUsageSnapshot({
      profileId: 'backup',
      now,
      remainingPct: 0,
      resetAtMs,
      groupGeneration: 4,
    });
    accountUsageStore.recordSnapshot(
      primaryBlocked,
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'primary', groupGeneration: 4 }),
    );
    accountUsageStore.recordSnapshot(
      backupBlocked,
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup', groupGeneration: 4 }),
    );

    const qualifiedGroup = (): QualifiedConnectedAccountGroupV4 => ({
      v: 1,
      ref: {
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        groupId: 'team',
      },
      incarnation: 'qualified-group-team',
      displayName: 'Team',
      activeConnectedAccountId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        strategy: 'priority',
        cooldownMs: 500,
      },
      state: { v: 1 },
      members: ['primary', 'backup'].map((connectedAccountId, index) => ({
        v: 1,
        connectedAccountId,
        priority: index,
        enabled: true,
        state: {},
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const readGroup = vi.fn(async () => qualifiedGroup());
    const api = {
      getConnectedServiceAuthGroup: vi.fn(() => {
        throw new Error('legacy V3 group reader must not be called');
      }),
    } as unknown as QuotaApi;
    const onQuotaLifecycleTransition = vi.fn(async () => {});
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      accountUsageStore,
      onQuotaLifecycleTransition,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4' as const,
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(),
        },
        listScheduledAccounts: vi.fn(async () => []),
        readGroup,
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      accountUsageStore: typeof accountUsageStore;
      onQuotaLifecycleTransition: typeof onQuotaLifecycleTransition;
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

    await (coordinator as unknown as {
      handleAccountUsageChanged(input: Readonly<{
        sessionId: string;
        serviceId: 'openai-codex';
        profileId: string;
        groupId: string;
        groupGeneration: number;
        recordId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
      }>): Promise<void>;
    }).handleAccountUsageChanged({
      sessionId: 'session-quota-blocked',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      recordId: primaryBlocked.recordId,
      snapshot: primaryBlocked,
    });

    expect(onQuotaLifecycleTransition).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'blocked',
      serviceId: 'openai-codex',
      groupId: 'team',
      sessionIds: ['session-quota-blocked'],
      issueFingerprint: 'quota-blocked:openai-codex:team',
      resetAtMs,
    }));
    expect(readGroup).toHaveBeenCalledWith({
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      groupId: 'team',
    });

    accountUsageStore.recordSnapshot(
      buildConnectedGroupProviderAccountUsageSnapshot({
        profileId: 'backup',
        now: now + 1_000,
        remainingPct: 80,
        groupGeneration: 4,
      }),
      buildConnectedGroupProviderAccountUsageObservation({ profileId: 'backup', groupGeneration: 4 }),
    );
    await (coordinator as unknown as {
      handleAccountUsageChanged(input: Readonly<{
        sessionId: string;
        serviceId: 'openai-codex';
        profileId: string;
        groupId: string;
        groupGeneration: number;
        recordId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
      }>): Promise<void>;
    }).handleAccountUsageChanged({
      sessionId: 'session-quota-blocked',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'team',
      groupGeneration: 4,
      recordId: backupBlocked.recordId,
      snapshot: accountUsageStore.resolveBySource({
        serviceId: 'openai-codex',
        profileId: 'backup',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      }) ?? backupBlocked,
    });

    expect(onQuotaLifecycleTransition).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'recovered',
      serviceId: 'openai-codex',
      groupId: 'team',
      sessionIds: ['session-quota-blocked'],
      issueFingerprint: 'quota-blocked:openai-codex:team',
    }));
  });

  it('keeps quota probe lifecycle reconstruction passive; live account-usage changes emit rows', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const resetAtMs = now + 600_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const memberStates = new Map<string, Record<string, unknown>>([
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
    const buildGroup = (): ConnectedServiceAuthGroupResponse => ({
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
        strategy: 'least_limited',
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
    const records = new Map(['primary', 'backup'].map((profileId) => [
      profileId,
      buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId,
        kind: 'oauth',
        expiresAt: now + 60_000,
        oauth: {
          accessToken: `access-${profileId}`,
          refreshToken: `refresh-${profileId}`,
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: `acct-${profileId}`,
          providerEmail: `${profileId}@example.test`,
        },
      }),
    ]));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: records.get(profileId) ?? null },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;

    const remainingByProfileId = new Map<string, number>([['primary', 0], ['backup', 0]]);
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record }: FetchArgs) => {
        const remainingPct = remainingByProfileId.get(record.profileId) ?? 0;
        return buildAgentAccountUsageSnapshotFixture({
          record,
          now,
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
        });
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
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      onQuotaLifecycleTransition: typeof onQuotaLifecycleTransition;
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

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary'],
    });
    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary'],
    });
    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();

    remainingByProfileId.set('backup', 80);
    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });
    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });
    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();
  });

  it.each([
    {
      title:
        'does not mutate persisted member runtime blockers during a pre-turn group quota probe',
      changePeerDuringRuntimeStateRead: false,
      expectedUpdates: 0,
    },
    {
      title:
        'does not update legacy group runtime state after the peer changes during its read',
      changePeerDuringRuntimeStateRead: true,
      expectedUpdates: 0,
    },
  ])('$title', async ({
    changePeerDuringRuntimeStateRead,
    expectedUpdates,
  }) => {
    const now = 1_000_000;
    const resetAtMs = now + 600_000;
    let peerClass:
      | 'revisioned_v2_v3'
      | 'advertised_v4' = 'revisioned_v2_v3';
    let groupReadCount = 0;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access-primary',
        refreshToken: 'refresh-primary',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: 'primary@example.test',
      },
    });
    const group = (): ConnectedServiceAuthGroupResponse => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      displayName: 'Team',
      activeProfileId: 'primary',
      generation: 4,
      runtimeStateRevision: 0,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
      state: { v: 1 },
      members: [{
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        priority: 1,
        enabled: true,
        state: {
          quotaExhaustedUntilMs: resetAtMs,
          authInvalidUntilMs: resetAtMs,
          credentialHealthStatus: 'needs_reauth',
          lastFailureKind: 'auth_expired',
          lastObservedAtMs: now - 10_000,
          providerResetsAtMs: resetAtMs,
        },
        createdAt: 1,
        updatedAt: 2,
      }],
      createdAt: 1,
      updatedAt: 2,
    });
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => group());
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => {
        groupReadCount += 1;
        if (
          changePeerDuringRuntimeStateRead
          && groupReadCount === 2
        ) {
          peerClass = 'advertised_v4';
        }
        return group();
      }),
      updateConnectedServiceAuthGroupRuntimeState,
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
        planLabel: 'Pro',
        accountLabel: 'primary@example.test',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          remainingPct: 80,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      accountUsageStore: createProviderAccountUsageStore(),
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => peerClass,
        resolveOperationTransport: () =>
          peerClass === 'revisioned_v2_v3'
            ? {
                kind: 'legacy' as const,
                peerClass,
                serviceId: 'openai-codex' as const,
              }
            : { kind: 'v4' as const },
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(),
        },
        listScheduledAccounts: vi.fn(async () => []),
      } as unknown as QualifiedConnectedAccountQuotaRuntime,
    });

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary'],
    });

    if (expectedUpdates === 0) {
      expect(
        updateConnectedServiceAuthGroupRuntimeState,
      ).not.toHaveBeenCalled();
    } else {
      expect(
        updateConnectedServiceAuthGroupRuntimeState,
      ).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        groupId: 'team',
        expectedGeneration: 4,
        expectedRuntimeStateRevision: 0,
        memberStates: [{
          profileId: 'primary',
          state: { providerResetsAtMs: resetAtMs },
        }],
      });
    }
  });

  it('does not emit quota lifecycle transitions when every group member is auth-invalid', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const buildGroup = (): ConnectedServiceAuthGroupResponse => ({
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
        strategy: 'least_limited',
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
        createdAt: index + 1,
        updatedAt: index + 1,
      })),
      createdAt: 1,
      updatedAt: 2,
    });
    const records = new Map(['primary'].map((profileId) => [
      profileId,
      buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId,
        kind: 'oauth',
        expiresAt: now + 60_000,
        oauth: {
          accessToken: `access-${profileId}`,
          refreshToken: `refresh-${profileId}`,
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: `acct-${profileId}`,
          providerEmail: `${profileId}@example.test`,
        },
      }),
    ]));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async ({ profileId }: { profileId: string }) => ({
        content: { t: 'plain' as const, v: records.get(profileId) ?? null },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      })),
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
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      onQuotaLifecycleTransition: typeof onQuotaLifecycleTransition;
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

    await coordinator.probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['primary'],
    });

    expect(onQuotaLifecycleTransition).not.toHaveBeenCalled();
  });

  it('re-probes sibling runtime account identity before later fanout so stale proof is not reused', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => {
      if (now === 1_000_000) {
        return {
          status: 'exact' as const,
          providerAccountId: 'acct-a',
          accountLabel: null,
          profileId: 'primary',
          groupId: 'team',
          groupGeneration: 4,
          observedAtMs: now,
          inProviderTurn: false,
          safeToApply: true,
        };
      }
      return { status: 'inexact' as const, reason: 'runtime_identity_probe_inexact' };
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;

    for (const [sessionId, pid] of [['source', 201], ['same-account', 202]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
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
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledTimes(2);
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async ({ groupId }: { groupId: string }) => ({
      status: 'exact' as const,
      providerAccountId: 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId,
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: false,
      safeToApply: true,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutMinIntervalMs: 60_000,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    const registerGroupSession = (sessionId: string, pid: number, groupId: string) => {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    };
    registerGroupSession('source-a', 301, 'team-a');
    registerGroupSession('same-account-a', 302, 'team-a');
    registerGroupSession('source-b', 303, 'team-b');
    registerGroupSession('same-account-b', 304, 'team-b');
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
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledTimes(2);
  });

  it('fans out shared-auth-surface sessions without requiring provider account id', async () => {
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
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2, mode: 'hot_apply' as const }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      strategy: 'shared_group_auth_surface' as const,
      sharedAuthSurfaceId: 'team',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: false,
      safeToApply: true,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn },
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'shared_group_auth_surface',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 301], ['same-account', 302]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'claude',
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
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
      coordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: 'claude-subscription',
        groupId: 'team',
        profileId: 'primary',
        providerAccountId: 'acct-claude',
        accountLabel: null,
        observedAtMs: now,
        source: 'runtime_quota_snapshot',
        proofStrength: 'exact',
        groupGeneration: 4,
      });
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: '',
      resetAtMs: null,
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests: 0,
    });
    expect(readRuntimeAccountIdentityForFanout).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'same-account',
      serviceId: 'claude-subscription',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    }));
  });

  it('commits one hard-limit group decision and applies its immutable generation to every sibling', async () => {
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
      mode: 'hot_apply' as const,
    }));
    const sourceCommittedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'source-hard-limit-decision',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        generation: 9,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const fallbackApplyCommittedGeneration = vi.fn(async () => ({
      status: 'unexpected_fallback_apply' as const,
      generation: 9,
    }));
    const applyCommittedGeneration = vi.fn(async (input) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget: {
        ...input.committedGeneration.decisionCommittedTarget,
        proof: {
          status: 'verified' as const,
          source: 'test',
          credentialRevision: input.committedGeneration.decisionCommittedTarget.credentialRevision,
        },
      },
    }));
    const clearAdoptedGeneration = vi.fn(async (
      _input: Parameters<
        ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0]['clearAdoptedGeneration']
      >[0],
    ) => ({ status: 'cleared' as const }));
    const generationConsumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      clearAdoptedGeneration,
      resolveGenerationApplicationScope: vi.fn(async ({ sessionId }) => ({
        status: 'supported' as const,
        scope: 'per_session_runtime' as const,
        ownerId: sessionId,
      })),
      verifySharedGenerationApplication: vi.fn(async () => null),
    });
    const consumptionResults: Array<Awaited<ReturnType<typeof generationConsumer.consume>>> = [];
    const consumeCommittedAuthGroupGeneration = vi.fn(
      async (input: Parameters<typeof generationConsumer.consume>[0]) => {
        const result = await generationConsumer.consume(input);
        consumptionResults.push(result);
        return result;
      },
    );
    const readRuntimeAccountIdentityForFanout = vi.fn(async (input: Readonly<{ sessionId: string }>) => ({
      status: 'exact' as const,
      providerAccountId: input.sessionId === 'sibling-d' ? 'acct-b' : 'acct-a',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: false,
      safeToApply: true,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn, applyCommittedGeneration: fallbackApplyCommittedGeneration },
      consumeCommittedAuthGroupGeneration,
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'provider_account_id',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: {
        switchBeforeTurn: typeof switchBeforeTurn;
        applyCommittedGeneration: typeof fallbackApplyCommittedGeneration;
      };
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;

    for (const [sessionId, pid] of [
      ['source', 701],
      ['sibling-a', 702],
      ['sibling-b', 703],
      ['sibling-c', 704],
      ['sibling-d', 705],
    ] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'codex',
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
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
      if (sessionId !== 'source') {
        coordinator.recordRuntimeAccountIdentityFromSnapshot({
          sessionId,
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'primary',
          providerAccountId: sessionId === 'sibling-d' ? 'acct-b' : 'acct-a',
          accountLabel: null,
          observedAtMs: now,
          source: 'runtime_quota_snapshot',
          proofStrength: 'exact',
          groupGeneration: 4,
        });
      }
    }

    await expect(recordAccountExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct-a',
      resetAtMs: null,
      reason: 'usage_limit',
      committedGeneration: sourceCommittedGeneration,
      sourceRequiresConvergence: false,
    })).resolves.toEqual({
      status: 'recorded',
      // Exact provider-account proof scopes exhaustion attribution only. The committed
      // group generation still reaches the fourth group-bound sibling on acct-b.
      fanoutCandidates: 3,
      fanoutRequests: 4,
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(fallbackApplyCommittedGeneration).not.toHaveBeenCalled();
    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledOnce();
    const [consumption] = consumeCommittedAuthGroupGeneration.mock.calls[0]!;
    expect(consumption.committedGeneration).toBe(sourceCommittedGeneration);
    expect(consumption).toEqual(expect.objectContaining({
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      sessions: [
        expect.objectContaining({ sessionId: 'sibling-a', activity: 'live' }),
        expect.objectContaining({ sessionId: 'sibling-b', activity: 'live' }),
        expect.objectContaining({ sessionId: 'sibling-c', activity: 'live' }),
        expect.objectContaining({ sessionId: 'sibling-d', activity: 'live' }),
      ],
    }));
    expect(consumptionResults).toEqual([expect.objectContaining({
      acknowledgeable: true,
      outcome: 'adopted_current',
      appliedSessionCount: 4,
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 0,
      failedSessionCount: 0,
    })]);
    expect(applyCommittedGeneration).toHaveBeenCalledTimes(4);
    expect(applyCommittedGeneration.mock.calls.map(([input]) => input.sessionId).sort()).toEqual([
      'sibling-a',
      'sibling-b',
      'sibling-c',
      'sibling-d',
    ]);
    expect(applyCommittedGeneration.mock.calls.every(
      ([input]) => input.committedGeneration === sourceCommittedGeneration,
    )).toBe(true);
    expect(clearAdoptedGeneration).toHaveBeenCalledTimes(4);
    expect(clearAdoptedGeneration.mock.calls.every(
      ([input]) => input.providerAdoptedTarget.generation === 9,
    )).toBe(true);
  });

  it.each([
    ['adopted_current', 2],
    ['retryable_not_acknowledged', 0],
  ] as const)('reports committed-generation outcome %s without treating false consumption as success', async (outcome, fanoutRequests) => {
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
      generation: 2,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      mode: 'hot_apply' as const,
    }));
    const applyCommittedGeneration = vi.fn(async (input: Readonly<{
      activeProfileId: string;
      generation: number;
      credentialRevision?: string | null;
    }>) => ({
      status: 'generation_apply_failed' as const,
      activeProfileId: input.activeProfileId,
      generation: input.generation,
      errorCode: 'proof_unavailable',
    }));
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({
      acknowledgeable: outcome === 'adopted_current',
      outcome,
      appliedSessionCount: 1,
    }));
    const readRuntimeAccountIdentityForFanout = vi.fn(async () => ({
      status: 'exact' as const,
      strategy: 'shared_group_auth_surface' as const,
      sharedAuthSurfaceId: 'team',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      observedAtMs: now,
      inProviderTurn: false,
      safeToApply: true,
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      authGroupSwitchCoordinator: { switchBeforeTurn, applyCommittedGeneration },
      consumeCommittedAuthGroupGeneration,
      sameAccountFanoutMinIntervalMs: 0,
      sameAccountFanoutStrategyResolver: async (): Promise<SameAccountFanoutStrategy> => 'shared_group_auth_surface',
      readRuntimeAccountIdentityForFanout,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      sameAccountFanoutMinIntervalMs: number;
      sameAccountFanoutStrategyResolver: () => Promise<SameAccountFanoutStrategy>;
      readRuntimeAccountIdentityForFanout: typeof readRuntimeAccountIdentityForFanout;
    }) as RuntimeIdentityFanoutCoordinator;
    for (const [sessionId, pid] of [['source', 401], ['same-account', 402]] as const) {
      coordinator.registerSpawnTarget({
        pid,
        agentId: 'claude',
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
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      } as Parameters<ConnectedServiceQuotasCoordinator['registerSpawnTarget']>[0] & { agentId: string });
    }

    await expect(recordRuntimeUsageLimitExhaustionAndFanoutForTest(coordinator, {
      sourceSessionId: 'source',
      serviceId: 'claude-subscription',
      groupId: 'team',
      exhaustedProfileId: 'primary',
      resetAtMs: null,
      committedGeneration: hardLimitCommittedGenerationForTest({
        serviceId: 'claude-subscription',
        groupId: 'team',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }),
    })).resolves.toEqual({
      status: 'recorded',
      fanoutCandidates: 1,
      fanoutRequests,
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
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: 'same-account', activity: 'live' }),
        expect.objectContaining({ sessionId: 'source', activity: 'live' }),
      ]),
    }));
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
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
    });
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
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
    };
    const materialFingerprint = coordinator.computeQuotaSnapshotMaterialFingerprint(snapshot);

    expect(coordinator.resolveQuotaProbeFreshProof({
      serviceId: 'openai-codex',
      profileId: 'backup',
      expectedAppliedIdentity: {
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'team',
        groupGeneration: 8,
        providerAccountId: 'acct-provider-a',
        materialFingerprint,
      },
      snapshotAppliedIdentity: {
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'team',
        groupGeneration: 8,
        providerAccountId: 'acct-provider-a',
        materialFingerprint,
      },
      snapshot,
      maxAgeMs: 30_000,
    })).toEqual({
      status: 'proof',
      proofKind: 'quota_probe_fresh',
    });
  });

  it('routes probed group member quota snapshot writes through canonical account usage when available', async () => {
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async (): Promise<ConnectedServiceAuthGroupResponse> => ({
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

    const snapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 0,
          remainingPct: 100,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => snapshot),
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
      runtimeQuotaSnapshots,
      accountUsageStore,
      discoveryEnabled: false,
    });
    const probeGroupQuotaSnapshots = (coordinator as unknown as {
      probeGroupQuotaSnapshots?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: readonly string[];
      }>) => Promise<void>;
    }).probeGroupQuotaSnapshots?.bind(coordinator);
    expect(typeof probeGroupQuotaSnapshots).toBe('function');
    if (!probeGroupQuotaSnapshots) return;

    await probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
    })).toMatchObject({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'backup',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [expect.objectContaining({
        meterId: 'weekly',
        utilizationPct: 0,
        remainingPct: 100,
        resetsAt: now + 60_000,
        status: 'ok',
      })],
    });
    expect(accountUsagePersistence.recordInBandSnapshot).not.toHaveBeenCalled();
    expect(accountUsageStore.resolveBySource({
      serviceId: 'openai-codex',
      profileId: 'backup',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    })).toEqual(expect.objectContaining({
      providerId: 'openai-codex',
      planLabel: 'Pro',
    }));
    expect(accountUsageStore.listSnapshots()).toHaveLength(1);
  });

  it('does not hydrate persisted connected-service quota snapshots for requested group members', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
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
          utilizationPct: 20,
          remainingPct: 80,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: snapshot },
        metadata: {
          fetchedAt: now,
          staleAfterMs: 300_000,
          status: 'ok' as const,
        },
      })),
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
      runtimeQuotaSnapshots,
      discoveryEnabled: false,
    });
    const hydratePersistedQuotaSnapshotsForGroup = (coordinator as unknown as {
      hydratePersistedQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: readonly string[];
      }>) => Promise<void>;
    }).hydratePersistedQuotaSnapshotsForGroup?.bind(coordinator);
    expect(hydratePersistedQuotaSnapshotsForGroup).toBeUndefined();

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
    })).toBeNull();
    expect(api.getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    let uploadedStatus: string | null = null;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploadedStatus = params.write.status;
      }),
    };

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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

  it('does not overwrite useful stale quota when a refresh returns only quota_unknown placeholders', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const staleUsefulSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now - 10 * 60_000,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      activeAccountId: 'acct-stale',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 64,
          remainingPct: 36,
          resetsAt: now + 60 * 60_000,
          status: 'ok',
          details: {},
        },
      ],
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
        providerAccountId: 'acct-fetched',
        providerEmail: 'fresh@example.com',
      },
    });
    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
        metadata: { kind: 'oauth' },
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async (_params: QualifiedProviderAccountUsageWriteArgs) => {}),
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
        planLabel: null,
        accountLabel: 'fresh@example.com',
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
            details: { code: 'quota_unknown' },
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

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
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
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
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
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (_args: FetchArgs) => new Promise<null>(() => {})),
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    let uploadedCiphertext: string | null = null;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploadedCiphertext = readSealedQualifiedProviderAccountUsageCiphertext(params);
      }),
    };

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs) => buildAgentAccountUsageSnapshotFixture({
        record: inputRecord,
        now,
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

    const opened = openProviderAccountUsageSnapshotCiphertext({
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const existingQuotaSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: {
        format: 'account_scoped_v1',
        ciphertext: sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
          material: {
            type: 'legacy',
            secret: credentials.encryption.secret,
          },
          payload: existingQuotaSnapshot,
          randomBytes: (length) => randomBytes(length),
        }),
      },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async () => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', loadQuota: vi.fn(async (_args: FetchArgs) => null) };

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
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
	    };

	    const api = {
	      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      loadQuota: vi.fn(async ({ signal }: FetchArgs) => {
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
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
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
	      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
	      getConnectedServiceCredentialSealed: vi.fn(async () => null),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', loadQuota: vi.fn(async (_args: FetchArgs) => null) };

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
    expect(fetcher.loadQuota).not.toHaveBeenCalled();
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
      meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: 1,
        limit: 10,
        unit: 'count',
        utilizationPct: 10,
        resetsAt: now + 60_000,
        status: 'ok',
        details: {},
      }],
    };
    const freshUsageSnapshot = buildAgentAccountUsageSnapshotFixture({
      record,
      now,
      planLabel: freshSnapshot.planLabel,
      accountLabel: freshSnapshot.accountLabel,
      state: 'loaded_empty',
      meters: [],
    });

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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        if (params.write.payloadMode !== 'plain_json_v1') {
          throw new Error('Expected a plaintext qualified provider-account usage write');
        }
        if (!params.write.snapshot) {
          throw new Error('Expected plaintext qualified provider-account usage payload');
        }
        const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
          snapshot: params.write.snapshot,
          source: {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
          },
        });
        if (!projected) throw new Error('Expected provider account usage source projection');
        serverSnapshot = projected;
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async (
        params: Parameters<NonNullable<QuotaApi['acquireConnectedServiceRefreshLease']>>[0],
      ) => {
        const ownerId = params.ownerId ?? 'legacy-owner';
        if (!leaseOwner || leaseOwner === ownerId) {
          leaseOwner = ownerId;
          return { acquired: true, leaseUntil: now + params.leaseMs };
        }
        return { acquired: false, leaseUntil: now + 50 };
      }),
    };
    const api = apiWithLease;

    let loadCallCount = 0;
    const loadQuotaMock = vi.fn(async (_args: FetchArgs) => {
      loadCallCount += 1;
      if (loadCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
      }
      return freshUsageSnapshot;
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: loadQuotaMock,
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
      machineIdProvider: () => 'machine-1',
      quotaFetchLeaseMs: 10_000,
      quotaFetchLeaseContentionWaitMaxMs: 100,
      sleepMs,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0];

    const coordinatorA = new ConnectedServiceQuotasCoordinator({
      ...common,
      ownerIdProvider: () => 'machine-1:daemon-a',
    });
    const coordinatorB = new ConnectedServiceQuotasCoordinator({
      ...common,
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
    await vi.waitFor(() => expect(loadQuotaMock).toHaveBeenCalledTimes(1));

    const tickB = coordinatorB.tickOnce();
    await vi.waitFor(() => {
      if (sleepMs.mock.calls.length === 0 && loadQuotaMock.mock.calls.length < 2) {
        throw new Error('waiting for quota lease contention');
      }
    });

    releaseFirstFetch();
    await tickA;
    releaseSleep();
    await tickB;

    expect(loadQuotaMock).toHaveBeenCalledTimes(1);
    expect(
      apiWithLease.acquireConnectedServiceRefreshLease.mock.calls
        .every(([request]) =>
          request.expectedCredentialRevision
          === 'csr_0123456789ABCDEFGHJKMNPQRS'),
    ).toBe(true);
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => {
        throw new Error('lease service unavailable');
      }),
    };
    const api = apiWithFailingLease as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
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
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(apiWithFailingLease.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    await coordinator.tickOnce();

    expect(fetcher.loadQuota).not.toHaveBeenCalled();
    expect(apiWithFailingLease.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(apiWithFailingLease.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(apiWithFailingLease.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(2);
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
	    };

	    const api = {
	      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      loadQuota: vi.fn(async (_args: FetchArgs) => {
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
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

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(2);
  });

  it('uses provider retry timing for quota fetch failure backoff when supplied', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      loadQuota: vi.fn(async () => {
        const error = new Error('provider asked us to retry later') as Error & { retryAfterMs: number };
        error.retryAfterMs = 90_000;
        throw error;
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
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 60_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 30_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(2);
  });

  it('keeps an unclassified raw 403 retryable instead of latching reconnect-required health', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

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
        scope: 'user:inference user:profile',
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
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
        metadata: { kind: 'oauth' },
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      terminalAuthFailureProviderCodes: ['missing_claude_code_scope'],
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError('ambiguous forbidden response', {
          status: 403,
          quotaFetchErrorCode: 'auth_failure',
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
      discoveryEnabled: false,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);
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

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(5);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: 1_130_000,
        lastRefreshFailureAt: 1_130_000,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
      },
    });
  });

  it('marks provider-declared quota auth failures as reconnect-required credential health', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      kind: 'oauth',
      expiresAt: now + 60_000,
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

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      terminalAuthFailureProviderCodes: ['missing_claude_code_scope'],
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
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
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'legacy' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
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

  it('classifies a Claude-declared quota providerCode as reconnect-required (scoped via descriptor terminalAuthFailureProviderCodes)', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

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
        scope: 'user:inference user:profile',
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    // No HTTP status: classification here depends entirely on the providerCode being one of
    // the codes the Claude quota descriptor declares via `terminalAuthFailureProviderCodes`.
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      terminalAuthFailureProviderCodes: [
        'missing_claude_code_scope',
        'claude_subscription_missing_claude_code_scope',
      ],
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
          'Claude subscription is missing Claude Code OAuth scope; reconnect Claude in Happier and retry.',
          {
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
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'missing_claude_code_scope',
      },
    });
  });

  it('does NOT treat the Claude-only providerCode as terminal for a different provider that never declared it (scoping proof)', async () => {
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    // Same providerCode string as the Claude test above, but this fetcher never declares
    // `terminalAuthFailureProviderCodes` — the coordinator must NOT globally union Claude's
    // codes onto another provider's classification.
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
          'provider auth failed',
          {
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

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'missing_claude_code_scope',
      },
    });
  });

  it('classifies standard OAuth2 providerCodes (e.g. invalid_grant) as terminal for any provider, with no per-provider declaration required', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    // Gemini declares no `terminalAuthFailureProviderCodes` at all, yet the standard OAuth2
    // code must still be terminal — it is centralized, not provider-declared.
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'gemini',
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
          'provider auth failed',
          {
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'invalid_grant',
          },
        );
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
        bindingsByServiceId: { gemini: { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'gemini',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'invalid_grant',
      },
    });
  });

  it('keeps transient unrecovered quota 401 failures retryable before reconnect escalation', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

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
        scope: 'user:inference user:profile',
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
          'provider auth failed',
          {
            status: 401,
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
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    now += 10_000;
    await coordinator.tickOnce();

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenNthCalledWith(1, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
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
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
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
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

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
        scope: 'user:inference user:profile',
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'claude-subscription',
      loadQuota: vi.fn(async () => {
        throw new QuotaFetchError(
          'provider auth failed',
          {
            status: 401,
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
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
    });

    for (const advanceMs of [0, 10_000, 20_000, 40_000, 60_000]) {
      now += advanceMs;
      await coordinator.tickOnce();
    }

    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(5);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenNthCalledWith(5, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision:
        'csr_0123456789ABCDEFGHJKMNPQRS',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: 1_130_000,
        lastRefreshFailureAt: 1_130_000,
        lastRefreshFailureKind: 'provider_401',
        providerHttpStatus: 401,
      },
    });
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const existingQuotaSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: {
        format: 'account_scoped_v1',
        ciphertext: sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
          material: {
            type: 'legacy',
            secret: credentials.encryption.secret,
          },
          payload: existingQuotaSnapshot,
          randomBytes: (length) => randomBytes(length),
        }),
      },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
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
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(2);
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
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };

    let uploadedCiphertext: string | null = null;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async (params: QualifiedProviderAccountUsageWriteArgs) => {
        uploadedCiphertext = readSealedQualifiedProviderAccountUsageCiphertext(params);
      }),
    };
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => buildAgentAccountUsageSnapshotFixture({
        record,
        now,
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
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');
  });
});
