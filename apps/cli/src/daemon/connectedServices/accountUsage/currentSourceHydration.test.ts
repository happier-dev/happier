import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceAuthGroupPolicyV1Schema,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceCurrentSourceHydrationConflictError,
  hydrateProviderAccountUsageStoreFromConnectedServiceInventory,
} from './currentSourceHydration';
import { createProviderAccountUsageStore } from './store';

const qualifiedService: QualifiedConnectedAccountServiceRef = {
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
};

function createProfile(accountId = 'work'): QualifiedConnectedAccountProfileV4 {
  return {
    ref: { service: qualifiedService, accountId },
    status: 'connected',
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true,
    configurationRevision: 'cfg-current',
    kind: 'oauth',
    expiresAt: null,
    providerIdentity: { accountId: `acct-${accountId}` },
    displayName: accountId,
    scopes: [],
  };
}

function createGroup(accountId = 'work'): QualifiedConnectedAccountGroupV4 {
  return {
    v: 1,
    ref: { service: qualifiedService, groupId: 'team' },
    incarnation: 'qualified-group-team',
    displayName: 'Team',
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
    activeConnectedAccountId: accountId,
    generation: 4,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [{
      v: 1,
      connectedAccountId: accountId,
      priority: 1,
      enabled: true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

function createSnapshot() {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: 'acct-work',
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return {
    v: 1 as const,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject' as const, id: 'acct-work' },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 60_000,
    source: 'connectedServiceProbe' as const,
    confidence: 'confirmed' as const,
    state: 'loaded_data' as const,
    planLabel: null,
    accountLabel: null,
    meters: [],
  };
}

describe('hydrateProviderAccountUsageStoreFromConnectedServiceInventory', () => {
  it('uses the V4 account/group inventory and source-record owner through both atomic passes', async () => {
    const snapshot = createSnapshot();
    const accountSource: QualifiedConnectedServiceUsageSourceV4 = {
      ref: { service: qualifiedService, accountId: 'work' },
      bindingKind: 'account',
    };
    const groupSource: QualifiedConnectedServiceUsageSourceV4 = {
      ref: { service: qualifiedService, accountId: 'work' },
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    };
    const listAccounts = vi.fn(async () => ({
      service: qualifiedService,
      accounts: [createProfile()],
    }));
    const listGroups = vi.fn(async () => ({ groups: [createGroup()] }));
    const resolveSource = vi.fn(async ({ source }: { source: typeof accountSource | typeof groupSource }) => ({
      source,
      recordId: snapshot.recordId,
      providerAccountId: 'acct-work',
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
    }));
    const readProviderAccountUsageRecord = vi.fn(async () => ({
      content: { t: 'plain' as const, v: snapshot },
      metadata: {
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status: 'ok' as const,
      },
      sources: [accountSource, groupSource],
    }));
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listAccounts,
        listGroups,
        resolveSource,
        readProviderAccountUsageRecord,
        getAccountEncryptionMode: async () => 'plain' as const,
      },
      credentials: { token: 'token', encryption: null },
      store,
      nowMs: 1_001,
    });

    expect(result.sources).toEqual([
      { serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' },
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    ]);
    expect(result.hydration.hydratedRecordIds).toEqual([snapshot.recordId]);
    expect(listAccounts).toHaveBeenCalledTimes(2);
    expect(listGroups).toHaveBeenCalledTimes(2);
    expect(resolveSource).toHaveBeenCalledTimes(4);
    expect(readProviderAccountUsageRecord).toHaveBeenCalledTimes(1);
  });

  it('does not commit a partial V4 inventory when its second authoritative pass changes', async () => {
    const store = createProviderAccountUsageStore();
    let inventoryReads = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listAccounts: async () => ({
          service: qualifiedService,
          accounts: inventoryReads++ === 0
            ? [createProfile('work')]
            : [createProfile('work'), createProfile('backup')],
        }),
        listGroups: async () => ({ groups: [] }),
        resolveSource: async () => null,
        readProviderAccountUsageRecord: async () => null,
        getAccountEncryptionMode: async () => 'plain' as const,
      },
      credentials: { token: 'token', encryption: null },
      store,
      nowMs: 1,
    })).rejects.toBeInstanceOf(
      ConnectedServiceCurrentSourceHydrationConflictError,
    );
    expect(store.listSnapshots()).toEqual([]);
  });
});
