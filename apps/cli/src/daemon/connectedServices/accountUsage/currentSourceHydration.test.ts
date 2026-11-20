import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceAuthGroupPolicyV2Schema,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
  listQualifiedConnectedAccountGroupsV4,
  listQualifiedConnectedAccountsV4,
  readQualifiedProviderAccountUsageRecordV4,
  resolveQualifiedProviderAccountUsageSourceV4,
} from '@/api/client/qualifiedConnectedAccountApi';

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
    policy: ConnectedServiceAuthGroupPolicyV2Schema.parse({}),
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

function createSnapshot(accountId = 'work') {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: `acct-${accountId}`,
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return {
    v: 1 as const,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject' as const, id: `acct-${accountId}` },
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
  it('keeps a refused source listed without disabling healthy siblings and hydrates it after recovery', async () => {
    const snapshots = [createSnapshot('work'), createSnapshot('backup')];
    let ownershipRefused = false;
    let backupResolutionStatuses: number[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (input, config) => {
      const url = new URL(String(input));
      let response: { status: number; data: unknown };
      if (url.pathname.endsWith('/accounts')) {
        response = { status: 200, data: {
          service: qualifiedService,
          accounts: [createProfile('work'), createProfile('backup')],
        } };
      } else if (url.pathname.endsWith('/groups')) {
        response = { status: 200, data: { groups: [] } };
      } else if (url.pathname.endsWith('/sources/resolve')) {
        const source: QualifiedConnectedServiceUsageSourceV4 = JSON.parse(url.searchParams.get('source')!);
        const snapshot = snapshots.find(candidate => candidate.recordKey.accountSubjectId === `acct-${source.ref.accountId}`)!;
        const status = source.ref.accountId === 'backup'
          ? backupResolutionStatuses.shift() ?? (ownershipRefused ? 409 : 200)
          : 200;
        response = status === 409
          ? { status, data: { error: 'ownership_unproven' } }
          : status === 404
            ? { status, data: {} }
            : { status: 200, data: {
            source,
            recordId: snapshot.recordId,
            providerAccountId: snapshot.recordKey.accountSubjectId,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
          } };
      } else if (url.pathname.endsWith('/record')) {
        const snapshot = snapshots.find(candidate => candidate.recordId === url.searchParams.get('recordId'))!;
        response = { status: 200, data: {
          content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
          sources: [{ ref: { service: qualifiedService, accountId: snapshot.recordKey.accountSubjectId.slice('acct-'.length) }, bindingKind: 'account' }],
        } };
      } else {
        throw new Error('Unexpected usage HTTP request');
      }
      // Preserve Axios status admission so a discarded 409 body fails this seam.
      if (!(config?.validateStatus ?? axios.defaults.validateStatus)?.(response.status)) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { response, status: response.status });
      }
      return response;
    });
    const source = (profileId: string) => ({
      serviceId: 'happier.agent.codex/openai-codex', profileId, bindingKind: 'profile' as const,
    });
    const hydrate = (store: ReturnType<typeof createProviderAccountUsageStore>) =>
      hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
        serviceIds: ['openai-codex'],
        api: {
          listAccounts: params => listQualifiedConnectedAccountsV4({ token: 'fixture', ...params }),
          listGroups: params => listQualifiedConnectedAccountGroupsV4({ token: 'fixture', ...params }),
          resolveSource: params => resolveQualifiedProviderAccountUsageSourceV4({ token: 'fixture', ...params }),
          readProviderAccountUsageRecord: params => readQualifiedProviderAccountUsageRecordV4({ token: 'fixture', ...params }),
          getAccountEncryptionMode: async () => 'plain',
        },
        credentials: { token: 'fixture', encryption: null },
        store,
        nowMs: 1_001,
      });

    try {
      const control = await hydrate(createProviderAccountUsageStore());
      expect(control.hydration.dispositions.map(item => item.status)).toEqual(['hydrated_fresh', 'hydrated_fresh']);

      ownershipRefused = true;
      const store = createProviderAccountUsageStore();
      const refused = await hydrate(store);
      expect(refused.sources).toEqual([source('work'), source('backup')]);
      expect(refused.hydration.dispositions).toEqual([
        { source: source('work'), status: 'hydrated_fresh', recordId: snapshots[0]!.recordId },
        { source: source('backup'), status: 'ownership_unproven' },
      ]);
      expect(refused.hydration.refreshSources).toEqual([source('backup')]);
      expect(store.resolveBySource(source('work'))?.recordId).toBe(snapshots[0]!.recordId);
      expect(store.resolveBySource(source('backup'))).toBeNull();

      ownershipRefused = false;
      const recovered = await hydrate(store);
      expect(recovered.hydration.dispositions.map(item => item.status)).toEqual(['hydrated_fresh', 'hydrated_fresh']);
      expect(recovered.hydration.refreshSources).toEqual([]);
      expect(store.resolveBySource(source('backup'))?.recordId).toBe(snapshots[1]!.recordId);

      ownershipRefused = true;
      await hydrate(store);
      expect(store.resolveBySource(source('work'))?.recordId).toBe(snapshots[0]!.recordId);
      expect(store.resolveBySource(source('backup'))).toBeNull();

      const transitions: unknown[] = [];
      for (const statuses of [[404, 409], [409, 200]]) {
        backupResolutionStatuses = [...statuses];
        await hydrate(store).then(
          () => { transitions.push('committed'); },
          (error: unknown) => { transitions.push(error); },
        );
      }
      expect(transitions).toEqual([
        expect.any(ConnectedServiceCurrentSourceHydrationConflictError),
        expect.any(ConnectedServiceCurrentSourceHydrationConflictError),
      ]);
    } finally {
      get.mockRestore();
    }
  });

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
      service: { ...qualifiedService, retiredServiceField: true },
      accounts: [{ ...createProfile(), retiredProfileField: true,
        ref: { ...createProfile().ref, retiredRefField: true } }],
    }));
    const listGroups = vi.fn(async () => ({ groups: [{ ...createGroup(), retiredGroupField: true,
      members: createGroup().members.map(member => ({ ...member, retiredMemberField: true })) }] }));
    const resolveSource = vi.fn(async ({ source }: { source: typeof accountSource | typeof groupSource }) => ({
      source: { ...source, retiredSourceField: true, ref: { ...source.ref, retiredRefField: true } },
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
      sources: [accountSource, groupSource].map(source => ({ ...source, retiredSourceField: true,
        ref: { ...source.ref, service: { ...source.ref.service, retiredServiceField: true } } })),
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

    // Canonical source identity: the exact qualified contribution key the current
    // lifecycle/group resolution looks up. Store source lookup is literal; there
    // is deliberately no alias/fallback path.
    expect(result.sources).toEqual([
      {
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      {
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    ]);
    expect(result.hydration.hydratedRecordIds).toEqual([snapshot.recordId]);
    // The hydrated snapshot must be immediately visible through the current
    // lifecycle lookup key: the qualified profile source and the
    // generation-qualified group_member source committed by the atomic passes.
    expect(store.resolveBySource({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    })).not.toBeNull();
    expect(store.resolveBySource({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    })).not.toBeNull();
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
