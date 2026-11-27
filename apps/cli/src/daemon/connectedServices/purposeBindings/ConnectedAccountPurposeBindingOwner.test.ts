import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type {
  QualifiedConnectedAccountPurposeBindingsV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountGroupV4,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import { PluginConnectedAccountAuthenticationV2Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';

import { ConnectedAccountRequestAuthError } from '../requestAuth/ConnectedAccountRequestAuthService';
import {
  composeConnectedAccountSessionPurposeBindingSnapshot,
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingOwnerDependencies,
  type ConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
  scopeConnectedAccountPurposeBindingLease,
} from './ConnectedAccountPurposeBindingOwner';

const purpose = {
  consumer: { pluginId: 'happier.agent.test', localId: 'runtime' },
  purpose: 'model-request',
} as const;
const service = {
  pluginId: 'happier.connected-account.test',
  localId: 'subscription',
} as const;
const otherService = {
  pluginId: 'happier.connected-account.other',
  localId: 'subscription',
} as const;

it('selects native credentials only for an unbound purpose and never for unavailable admitted selections', async () => {
  const { owner, store } = createOwner();
  const signal = new AbortController().signal;
  const request = { purpose, serviceRefs: [service], signal };
  expect(await owner.getBinding(request)).toBeNull();
  expect(await owner.resolveSelection!(request)).toEqual({ credentialSource: 'machineLogin' });
  await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'selected' } } }] }));
  expect(await owner.resolveSelection!(request)).toMatchObject({ credentialSource: 'connectedAccount', binding: { account: { accountId: 'selected' } } });
  await expect(owner.resolveSelection!({ ...request, serviceRefs: [otherService] })).rejects.toMatchObject({
    code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'scope_unauthorized' },
  });
  const missing = createOwner({ store, resolveAvailable: () => false }).owner;
  await expect(missing.resolveSelection!(request)).rejects.toMatchObject({
    code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'target_unavailable' },
  });
  await expect(owner.resolveSelection!({ ...request, exactPurposeBindingSubjectId: 'retired-run' })).rejects.toMatchObject({
    code: 'plugin_connected_account_binding_unavailable',
  });
});

it('uses an explicit finite Account selection without replacing the default, and retires it after disposal', async () => {
  const { owner, store } = createOwner();
  const signal = new AbortController().signal;
  const selected = await owner.prepareOperationSelection!({ purpose, serviceRefs: [service],
    account: { service, accountId: 'work' }, operationId: 'explicit-clone', signal });
  expect(await selected.owner.getBinding({ purpose, serviceRefs: [service], signal })).toMatchObject({ account: { accountId: 'work' } });
  const request = { purpose, serviceRefs: [service], signal,
    request: { kind: 'environment' as const, keys: ['TOKEN'] } };
  expect(await selected.owner.materialize(request)).toMatchObject({ env: { TOKEN: 'token:work' } });
  expect(store.current()).toEqual({ v: 1, bindings: [] });
  selected.dispose();
  await expect(selected.owner.materialize(request)).rejects.toThrow();
  await expect(owner.prepareOperationSelection!({ purpose, serviceRefs: [service],
    account: { service: otherService, accountId: 'foreign' }, operationId: 'wrong-service', signal })).rejects.toThrow();
});

const testAuthentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
  id: 'token', kind: 'manual', outcomeReconciliation: 'none',
  fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
}] });

function accountProfiles(accountIds: readonly string[]) {
  return accountIds.map(accountId => QualifiedConnectedAccountProfileV4Schema.parse({
    ref: { service, accountId }, authenticationModeId: 'token', status: 'connected',
    revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true, configurationRevision: null, scopes: [], displayName: `Account ${accountId}`,
  }));
}

function accountTargetResolver(accountIds: readonly string[]) {
  // V4 metadata transport supplies validated rows; target resolution remains real.
  const profiles = accountProfiles(accountIds);
  return createPurposeTargetResolver({ available: true,
    resolveService: async ref => ref.pluginId === service.pluginId && ref.localId === service.localId
      ? { service, authentication: testAuthentication } : null,
    listAccounts: async () => profiles,
  });
}

function memoryStore(): ConnectedAccountPurposeBindingStore & Readonly<{
  current(): QualifiedConnectedAccountPurposeBindingsV1;
  invalidate(): void;
}> {
  let current: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
  const listeners = new Set<() => void>();
  return {
    read: async () => current,
    update: async (mutate) => {
      current = mutate(current);
      for (const listener of listeners) listener();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    current: () => current,
    invalidate: () => {
      for (const listener of listeners) listener();
    },
  };
}

function createOwner(input: Readonly<{
  store?: ReturnType<typeof memoryStore>;
  selected?: QualifiedConnectedAccountPurposeBindingTargetV1;
  selectTarget?: () => Promise<QualifiedConnectedAccountPurposeBindingTargetV1>;
  currentGroupAccountId?: () => string;
  resolveAvailable?: () => boolean;
  resolveTarget?: ConnectedAccountPurposeBindingOwnerDependencies['resolveTarget'];
  resolveCredentialRevision?: ConnectedAccountPurposeBindingOwnerDependencies[
    'resolveCredentialRevision'
  ];
  materializeAccount?: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'];
  materializeNative?: ConnectedAccountPurposeBindingOwnerDependencies['materializeNative'];
  subscribeInvalidations?: ConnectedAccountPurposeBindingOwnerDependencies['subscribeInvalidations'];
  credentialOwnerAccountId?: string;
}> = {}) {
  const store = input.store ?? memoryStore();
  const materializeAccount = vi.fn(input.materializeAccount ?? (async ({ account, request }) => {
    if (request.kind !== 'environment') throw new Error('test only supports environment');
    return {
      kind: 'environment' as const,
      env: Object.fromEntries(request.keys.map((key: string) => [key, `token:${account.accountId}`])),
    };
  }));
  const owner = createConnectedAccountPurposeBindingOwner({
    store,
    selectTarget: input.selectTarget ?? (async () => input.selected ?? ({
      kind: 'account' as const,
      account: { service, accountId: 'fixed' },
    })),
    resolveTarget: input.resolveTarget ?? (async (target) => input.resolveAvailable?.() === false
        ? null
        : target.kind === 'account'
        ? {
            displayName: `Account ${target.account.accountId}`,
            account: target.account,
          }
        : {
            displayName: `Group ${target.groupId}`,
            account: {
              service: target.service,
              accountId: input.currentGroupAccountId?.() ?? 'alpha',
            },
          }),
    resolveCredentialRevision: input.resolveCredentialRevision,
    materializeAccount,
    materializeNative: input.materializeNative,
    subscribeInvalidations: input.subscribeInvalidations,
    credentialOwnerAccountId: input.credentialOwnerAccountId,
    async projectTargetAccounts() {
      throw new Error('target-scoped listing is outside this binding-lifecycle fixture');
    },
    async assertTargetAccountMaterializable() {
      throw new Error('listed-account materialization is outside this binding-lifecycle fixture');
    },
  });
  return { owner, store, materializeAccount };
}

const authorized = {
  purpose,
  serviceRefs: [service],
  assertGenerationCurrent: () => undefined,
} as const;


describe('Session request-auth register-then-serve', () => {
    const lease = { isCurrent: () => true, requestAuth: {}, resolvePurposeBinding: () => null } as never;
    it('serves a subject whose consumer writes no transcript without any runner channel', async () => {
        const subject = scopeConnectedAccountPurposeBindingLease({
            lease, subjectId: 'run:no-transcript', uses: [], registerRedaction: () => undefined,
        });
        await expect(subject.registerRedaction(['dummy-no-transcript-credential'])).resolves.toBeUndefined();
    });

    it("refuses a Session subject's serve when the runtime that writes its transcript is unreachable", async () => {
        const subject = scopeConnectedAccountPurposeBindingLease({
            lease, subjectId: 'session:unhosted', uses: [], registerRedaction: () => undefined,
            transcriptSessionId: 'sess-without-reachable-runtime',
        });
        // The owner's typed refusal: the helper's closed vocabulary maps it to request_auth_unavailable,
        // and the daemon log keeps the cause.
        const refusal = await subject.registerRedaction(['dummy-unregistered-credential']).then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(ConnectedAccountRequestAuthError);
        expect(refusal).toMatchObject({ code: 'request_auth_credential_unavailable',
            diagnostic: { causeCode: 'session_transcript_runtime_unavailable' } });
    });
});

describe('ConnectedAccountPurposeBindingOwner', () => {
  it('reads the recorded group and profile revisions without selecting or materializing credentials', async () => {
    const profiles = accountProfiles(['alpha', 'beta']);
    const beta = profiles[1];
    if (beta?.revisionSemantics !== 'revisioned') throw new Error('Fixture profiles are revisioned');
    profiles[1] = { ...beta, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
      configurationRevision: 'configuration-beta' };
    const group: QualifiedConnectedAccountGroupV4 = { v: 1, ref: { service, groupId: 'observed' },
      incarnation: 'group-row', displayName: 'Observed', policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
      activeConnectedAccountId: 'beta', generation: 7, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
      members: ['alpha', 'beta'].map(connectedAccountId => ({ v: 1 as const, connectedAccountId,
        priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    };
    const listAccounts = vi.fn(async () => profiles);
    const readGroup = vi.fn(async () => group);
    const selectTarget = vi.fn(async () => ({ kind: 'account' as const, account: profiles[0].ref }));
    const resolveCredentialRevision = vi.fn(async () => profiles[0].credentialRevision);
    const { owner, store, materializeAccount } = createOwner({ selectTarget, resolveCredentialRevision,
      resolveTarget: createPurposeTargetResolver({ available: true,
        resolveService: async () => ({ service, authentication: testAuthentication }), listAccounts, readGroup }),
    });
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'group', service, groupId: 'observed' } }] }));
    const observed = await owner.readBindingObservation({ ...authorized, signal: new AbortController().signal });
    expect(observed).toMatchObject({ account: profiles[1].ref, group: { groupId: 'observed', generation: 7 },
      credentialRevision: profiles[1].credentialRevision, configurationRevision: 'configuration-beta' });
    expect(listAccounts).toHaveBeenCalledOnce();
    expect(readGroup).toHaveBeenCalledOnce();
    expect(selectTarget).not.toHaveBeenCalled();
    expect(materializeAccount).not.toHaveBeenCalled();
    expect(resolveCredentialRevision).not.toHaveBeenCalled();
  });

  it('returns absent for a pool with no recorded usable member in one metadata observation', async () => {
    const profiles = accountProfiles(['alpha']);
    const listAccounts = vi.fn(async () => profiles);
    const readGroup = vi.fn(async (): Promise<QualifiedConnectedAccountGroupV4> => ({
      v: 1, ref: { service, groupId: 'unselected' }, incarnation: 'group-row', displayName: 'Unselected',
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, activeConnectedAccountId: null,
      generation: 0, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
      members: [{ v: 1, connectedAccountId: 'alpha', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }],
    }));
    const { owner, store, materializeAccount } = createOwner({
      resolveTarget: createPurposeTargetResolver({ available: true,
        resolveService: async () => ({ service, authentication: testAuthentication }), listAccounts, readGroup }),
    });
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'group', service, groupId: 'unselected' } }] }));
    await expect(owner.readBindingObservation({ ...authorized, signal: new AbortController().signal })).resolves.toBeNull();
    expect(listAccounts).toHaveBeenCalledOnce();
    expect(readGroup).toHaveBeenCalledOnce();
    expect(materializeAccount).not.toHaveBeenCalled();
  });

  it('observes the explicit binding instead of durable defaults only on demand', async () => {
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const resolveCredentialRevision = vi.fn(async () => revision);
    const { owner, store, materializeAccount } = createOwner({ resolveCredentialRevision,
      resolveTarget: accountTargetResolver(['default', 'explicit']) });
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'default' } } }] }));
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'agent_catalog_observation', operationId: 'observe', consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'explicit' } } }],
    });
    const input = { ...authorized, exactPurposeBindingSubjectId: lease.subjectId, signal: new AbortController().signal };
    try {
      const ordinary = await owner.getBinding(input);
      expect(ordinary).toMatchObject({ account: { accountId: 'explicit' } });
      expect(ordinary).not.toHaveProperty('credentialRevision');
      expect(resolveCredentialRevision).not.toHaveBeenCalled();
      await expect(owner.getBinding({ ...input, observation: true })).resolves.toMatchObject({
        account: { accountId: 'explicit' }, credentialRevision: revision,
      });
      expect(resolveCredentialRevision).not.toHaveBeenCalled();
      expect(materializeAccount).not.toHaveBeenCalled();
    } finally { lease.dispose(); }
  });

  it.each(['selection', 'reconciliation'] as const)(
    'reads published bindings without waiting for an in-flight %s writer', async (writerKind) => {
      const store = memoryStore();
      const signal = new AbortController().signal;
      const binding = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'retained' } } };
      await store.update(() => ({ v: 1, bindings: [binding] }));
      let releaseWrite!: () => void;
      let markWriting!: () => void;
      const writing = new Promise<void>(resolve => { markWriting = resolve; });
      const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
      const { owner } = createOwner({ store: {
        ...store,
        async update(mutate, updateSignal) {
          markWriting();
          await writeReleased;
          return store.update(mutate, updateSignal);
        },
      }, resolveCredentialRevision: async () => 'csr_0123456789ABCDEFGHJKMNPQRS' });
      const lease = owner.activatePurposeBindings({
        subject: { kind: 'operation', operationId: `slow-${writerKind}`, consumer: purpose.consumer, isCurrent: () => true },
        purposes: [purpose], bindings: [binding],
      });
      const retained = { ...authorized, exactPurposeBindingSubjectId: lease.subjectId, signal };
      let published = false;
      const writer = writerKind === 'selection'
        ? owner.requestSelection({ ...authorized, signal, reason: 'Change default' })
        : owner.reconcileAuthorizedPurposes({ consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
          signal, publish: () => { published = true; } });
      await writing;
      let completedReads = 0;
      const counted = async <T>(read: Promise<T>): Promise<T> => { const result = await read; completedReads++; return result; };
      const reads = Promise.all([
        counted(owner.getBinding(retained)),
        counted(owner.materialize({ ...retained, nativeService: service, request: { kind: 'environment', keys: ['TOKEN'] } })),
        counted(owner.resolveCurrentSessionPurposeBindingSnapshot({ authorizedPurposes: [authorized], signal })),
        counted(owner.resolveCurrentRequestAuthBinding({ subjectId: lease.subjectId, binding, signal })),
      ]);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        // Four reads, zero mutation-tail releases: no read may depend on the writer's I/O.
        expect(completedReads).toBe(4);
        expect(published).toBe(false);
      } finally {
        releaseWrite();
        await writer;
        await reads;
        lease.dispose();
      }
      const [summary, materialized, snapshot, requestAuth] = await reads;
      expect(summary?.account.accountId).toBe('retained');
      expect(materialized).toMatchObject({ kind: 'environment', env: { TOKEN: 'token:retained' } });
      expect(snapshot.bindings).toEqual([binding]);
      expect(requestAuth?.account.accountId).toBe('retained');
      // A subsequent read consumes the real default change rather than a new cache.
      const next = await owner.getBinding({ ...authorized, signal });
      if (writerKind === 'selection') expect(next?.account.accountId).toBe('fixed');
      else expect(next).toBeNull();
    },
  );

  it('serializes two selection writers while the first catalog commit is in flight', async () => {
    const store = memoryStore();
    let releaseFirst!: () => void;
    let markFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirst = resolve; });
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    let updates = 0;
    let selections = 0;
    const { owner } = createOwner({
      selectTarget: async () => ({ kind: 'account', account: { service, accountId: `selected-${++selections}` } }),
      store: { ...store, async update(mutate, signal) {
        if (++updates === 1) { markFirst(); await firstReleased; }
        return store.update(mutate, signal);
      } },
    });
    const input = { ...authorized, signal: new AbortController().signal, reason: 'Choose account' };
    const first = owner.requestSelection(input);
    await firstStarted;
    const second = owner.requestSelection(input);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(updates).toBe(1);
    } finally { releaseFirst(); }
    await expect(first).resolves.toMatchObject({ account: { accountId: 'selected-1' } });
    await expect(second).resolves.toMatchObject({ account: { accountId: 'selected-2' } });
    expect(updates).toBe(2);
    expect(store.current().bindings[0]?.target).toMatchObject({ account: { accountId: 'selected-2' } });
  });

  it('uses one published catalog for a Session snapshot while defaults change during target I/O', async () => {
    const store = memoryStore();
    const bindings = [purpose, { ...purpose, purpose: 'second-request' }].map((purpose, index) => ({
      purpose, target: { kind: 'account' as const, account: { service, accountId: `snapshot-${index}` } },
    }));
    await store.update(() => ({ v: 1, bindings }));
    let markResolving!: () => void;
    let releaseResolution!: () => void;
    const resolving = new Promise<void>(resolve => { markResolving = resolve; });
    const released = new Promise<void>(resolve => { releaseResolution = resolve; });
    let catalogReads = 0;
    const { owner } = createOwner({
      store: { ...store, async read(signal) { catalogReads++; return store.read(signal); } },
      resolveTarget: async target => {
        if (target.kind !== 'account') throw new Error('Expected account target');
        if (target.account.accountId === 'snapshot-0') { markResolving(); await released; }
        return { account: target.account, displayName: target.account.accountId };
      },
    });
    const snapshot = owner.resolveCurrentSessionPurposeBindingSnapshot({
      authorizedPurposes: bindings.map(binding => ({ ...authorized, purpose: binding.purpose })),
      signal: new AbortController().signal,
    });
    await resolving;
    // This persistent-store publication models another client's acknowledged defaults.
    await store.update(() => ({ v: 1, bindings: bindings.map(binding => ({ ...binding,
      target: { kind: 'account' as const, account: { service, accountId: 'next' } },
    })) }));
    releaseResolution();
    await expect(snapshot).resolves.toMatchObject({ bindings });
    expect(catalogReads).toBe(1);
  });

  it('materializes a finite operation’s exact account without fetching the admitted account inventory again', async () => {
    let inventoryReads = 0;
    let credentialReads = 0;
    const { owner } = createOwner({
      resolveTarget: async target => {
        inventoryReads++;
        if (target.kind !== 'account') throw new Error('Expected one exact account');
        return { account: target.account, displayName: 'Exact account' };
      },
      materializeAccount: async ({ account }) => {
        credentialReads++;
        if (credentialReads === 2) throw new Error('credential revoked at acquisition');
        return { kind: 'environment', env: { TOKEN: account.accountId } };
      },
    });
    const signal = new AbortController().signal;
    const selection = await owner.resolveBindingIntentSelection({ purpose,
      target: { kind: 'account', account: { service, accountId: 'exact' } }, serviceRefs: [service], signal });
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: 'read-exact', consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose], bindings: [selection.binding], bindingSelections: [selection],
    });
    const request = { ...authorized, exactPurposeBindingSubjectId: lease.subjectId, signal,
      request: { kind: 'environment' as const, keys: ['TOKEN'] } };
    try {
      await expect(owner.materialize(request)).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'exact' } });
      await expect(owner.materialize(request)).rejects.toThrow('credential revoked at acquisition');
      expect({ inventoryReads, credentialReads }).toEqual({ inventoryReads: 1, credentialReads: 2 });
    } finally { lease.dispose(); }
  });

  it('retains an admitted group selection through materialization without treating inventory invalidation as reselection', async () => {
    let generation = 1;
    const { owner, store, materializeAccount } = createOwner({ resolveTarget: async target => ({
      displayName: 'Selected group', account: { service, accountId: 'alpha' },
      ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation } } : {}),
    }) });
    const signal = new AbortController().signal;
    const selection = await owner.resolveBindingIntentSelection({ purpose,
      target: { kind: 'group', service, groupId: 'fallbacks' }, serviceRefs: [service], signal });
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: 'retained-group', consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose], bindings: [selection.binding], bindingSelections: [selection],
    });
    const request = { ...authorized, exactPurposeBindingSubjectId: lease.subjectId, signal,
      request: { kind: 'environment' as const, keys: ['TOKEN'] } };
    store.invalidate();
    await expect(owner.materialize(request)).resolves.toMatchObject({ kind: 'environment', env: { TOKEN: 'token:alpha' } });
    materializeAccount.mockClear();
    generation++;
    await expect(owner.materialize(request)).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(materializeAccount).not.toHaveBeenCalled();
    lease.dispose();
  });
  it('refuses a durable Team default outside an admitted Session without erasing it or opening credentials', async () => {
    const { owner, store, materializeAccount } = createOwner();
    const durable: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [], teamResourceSelections: [{
      purpose, teamId: 'compute-team', selection: { source: 'team_resource', resourceId: 'company-native', deliveryMode: 'brokered' },
    }] };
    await store.update(() => durable);
    await expect(owner.getBinding({ ...authorized, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'plugin_connected_account_team_resource_unavailable', details: { reason: 'session_required' },
    });
    expect(store.current()).toEqual(durable);
    expect(materializeAccount).not.toHaveBeenCalled();
  });

  it('refuses a snapshot when a retained direct Team choice leaves the declared service scope', async () => {
    const { owner, store } = createOwner({ resolveTarget: accountTargetResolver(['personal']) });
    const selection = { source: 'team_resource' as const, resourceId: 'company-credential', deliveryMode: 'direct' as const,
      disclosedMember: { service, accountId: 'shared-account' } };
    const durable: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [], teamResourceSelections: [{
      purpose, teamId: 'compute-team', selection,
    }] };
    await store.update(() => durable);
    const signal = new AbortController().signal;
    await expect(owner.resolveCurrentSessionPurposeBindingSnapshot({
      authorizedPurposes: [{ purpose, serviceRefs: [otherService] }], signal,
    })).rejects.toMatchObject({ code: 'plugin_connected_account_team_resource_unavailable',
      details: { reason: 'scope_unauthorized' } });
    expect(store.current()).toEqual(durable);
    await expect(owner.resolveCurrentSessionPurposeBindingSnapshot({
      authorizedPurposes: [{ purpose, serviceRefs: [service] }], signal,
    })).resolves.toMatchObject({
      bindings: [{ purpose, target: { kind: 'account', account: selection.disclosedMember } }],
      directMaterialOrigins: [{ purpose, teamId: 'compute-team', resourceId: selection.resourceId,
        disclosedMember: selection.disclosedMember }],
      teamResourceSelections: [{ purpose, teamId: 'compute-team', selection }],
    });
  });

  it.each(['subject_absent', 'subject_retired', 'purpose_unauthorized', 'scope_unauthorized', 'target_unavailable', 'unselected'] as const)(
    'classifies a required native-home binding read as %s without falling back to durable defaults', async reasonCode => {
      const { owner, store } = createOwner({ resolveAvailable: () => reasonCode !== 'target_unavailable' });
      await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'durable' } } }] }));
      const lease = owner.activatePurposeBindings({
        subject: { kind: 'execution_run', runId: 'native-home-run', runnerPid: 123, agentId: 'codex',
          isCurrent: () => reasonCode !== 'subject_retired' },
        purposes: reasonCode === 'purpose_unauthorized' ? [] : [purpose],
        bindings: reasonCode === 'purpose_unauthorized' || reasonCode === 'unselected' ? [] : [{ purpose,
          target: { kind: 'account', account: { service, accountId: 'captured' } } }],
      });
      const request = { ...authorized, exactPurposeBindingSubjectId: reasonCode === 'subject_absent' ? 'absent-subject' : lease.subjectId,
        ...(reasonCode === 'scope_unauthorized' ? { serviceRefs: [otherService] } : {}), signal: new AbortController().signal };
      try {
        // Ordinary plugin reads retain their null contract. A native-home read
        // needs a classified refusal, not a claim that the rollout disappeared.
        await expect(owner.getBinding(request)).resolves.toBeNull();
        await expect(owner.getBinding({ ...request, requireSelected: true })).rejects.toMatchObject({
          code: 'plugin_connected_account_binding_unavailable', details: { reasonCode },
        });
        if (reasonCode === 'unselected') {
          await expect(owner.resolveSelection!(request)).resolves.toEqual({ credentialSource: 'machineLogin' });
        } else {
          await expect(owner.resolveSelection!(request)).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_unavailable', details: { reasonCode },
          });
        }
        expect(store.current().bindings[0]?.target).toMatchObject({ account: { accountId: 'durable' } });
      } finally { lease.dispose(); }
    },
  );

  it('records the actual personal credential use only after exact operation materialization succeeds', async () => {
    let finish!: () => void;
    const { owner, materializeAccount } = createOwner({
      credentialOwnerAccountId: 'credential-owner',
      materializeAccount: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        return { kind: 'environment', env: { TOKEN: 'private-token' } };
      },
    });
    const recordOperationCredentialUse = vi.fn();
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: 'credential-action', consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose],
      bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'selected' } } }],
      recordOperationCredentialUse,
    });
    const pending = owner.materialize({ ...authorized, exactPurposeBindingSubjectId: lease.subjectId,
      signal: new AbortController().signal, request: { kind: 'environment', keys: ['TOKEN'] } });
    await vi.waitFor(() => expect(materializeAccount).toHaveBeenCalledOnce());
    expect(recordOperationCredentialUse).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(recordOperationCredentialUse.mock.calls).toEqual([[{
      v: 1, kind: 'connected_account', label: 'Account selected',
      owner: { kind: 'account', accountId: 'credential-owner' }, service,
      why: { kind: 'purpose_binding', purpose, target: 'account' },
      currentness: { kind: 'current_at_materialization' },
    }]]);
    lease.dispose();
  });

  it('reads the original Session selection for associated processes without acquiring or borrowing defaults', async () => {
    const { owner, store, materializeAccount } = createOwner();
    const selected = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'session-selected' } } };
    const lease = owner.activateSessionPurposeBindings({ sessionId: 'original-session', purposes: [purpose], bindings: [selected] });
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'later-default' } } }] }));
    const readDefaults = vi.spyOn(store, 'read');
    try {
      const snapshot = owner.readSessionPurposeBindingSnapshot('original-session');
      expect(snapshot).toEqual({ subjectId: lease.subjectId, purposes: [purpose], bindings: [selected] });
      expect(owner.readSessionPurposeBindingSnapshot('different-session')).toBeNull();
      expect(readDefaults).not.toHaveBeenCalled();
      expect(materializeAccount).not.toHaveBeenCalled();
      await expect(owner.materialize({ ...authorized, exactPurposeBindingSubjectId: snapshot!.subjectId,
        signal: new AbortController().signal, request: { kind: 'environment', keys: ['GH_TOKEN'] } }))
        .resolves.toMatchObject({ env: { GH_TOKEN: 'token:session-selected' } });
      expect(materializeAccount).toHaveBeenCalledOnce();
    } finally { lease.dispose(); }
    expect(owner.readSessionPurposeBindingSnapshot('original-session')).toBeNull();
    const native = owner.activateSessionPurposeBindings({ sessionId: 'native-session', purposes: [purpose], bindings: [] });
    try {
      expect(owner.readSessionPurposeBindingSnapshot('native-session'))
        .toEqual({ subjectId: native.subjectId, purposes: [purpose], bindings: [] });
      expect(readDefaults).not.toHaveBeenCalled();
    } finally { native.dispose(); }
  });

  it.each(['operation', 'action_operation'] as const)('admits a %s across its host-declared consumers while refusing an undeclared consumer', async kind => {
    const { owner } = createOwner();
    const cliPurpose = { consumer: { pluginId: 'happier.scm.forge.github', localId: 'gh' }, purpose: 'github.cli' };
    const input = { subject: { kind, operationId: 'agent-and-cli', actionId: 'acme.actions/setup', pluginVersion: '1.0.0', consumer: purpose.consumer,
      consumers: [purpose.consumer, cliPurpose.consumer], isCurrent: () => true }, purposes: [purpose, cliPurpose],
      bindings: [{ purpose: cliPurpose, target: { kind: 'account' as const, account: { service, accountId: 'selected' } } }] };
    const lease = owner.activatePurposeBindings(input);
    try {
      await expect(owner.materialize({ purpose: cliPurpose, serviceRefs: [service], exactPurposeBindingSubjectId: lease.subjectId,
        request: { kind: 'environment', keys: ['GH_TOKEN'] }, signal: new AbortController().signal }))
        .resolves.toMatchObject({ kind: 'environment', env: { GH_TOKEN: 'token:selected' } });
    } finally { lease.dispose(); }
    expect(() => owner.activatePurposeBindings({ ...input, subject: { ...input.subject, operationId: 'undeclared-cli', consumers: [purpose.consumer] } }))
      .toThrow('connected_account_operation_binding_consumer_mismatch');
    expect(() => owner.activatePurposeBindings({ ...input, subject: { ...input.subject, operationId: 'ordinary-action', consumers: undefined } }))
      .toThrow('connected_account_operation_binding_consumer_mismatch');
    expect(() => owner.activatePurposeBindings({ ...input, subject: { ...input.subject, operationId: 'unrelated-consumer' },
      purposes: [...input.purposes, { consumer: { pluginId: 'acme.unrelated', localId: 'tool' }, purpose: 'not-admitted' }] }))
      .toThrow('connected_account_operation_binding_consumer_mismatch');
  });

  it.each(['retired', 'failed'] as const)('settles admitted credential use when materialization is %s', async failure => {
    let current = true;
    const { owner, materializeAccount } = createOwner({ resolveTarget: accountTargetResolver(['selected']), materializeAccount: async () => {
      if (failure === 'failed') throw new Error('materializer unavailable');
      current = false;
      return { kind: 'environment', env: { TOKEN: 'private-token' } };
    } });
    const recordOperationCredentialUse = vi.fn();
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: `credential-${failure}`, consumer: purpose.consumer, isCurrent: () => current },
      purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'selected' } } }],
      recordOperationCredentialUse,
    });
    const input = { ...authorized, exactPurposeBindingSubjectId: lease.subjectId,
      signal: new AbortController().signal, request: { kind: 'environment' as const, keys: ['TOKEN'] } };
    const result = owner.materialize(input);
    if (failure === 'failed') {
      await expect(result).rejects.toThrow('materializer unavailable');
      expect(recordOperationCredentialUse).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'private-token' } });
      expect(recordOperationCredentialUse).toHaveBeenCalledOnce();
      await expect(owner.materialize(input)).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
      expect(materializeAccount).toHaveBeenCalledOnce();
    }
    lease.dispose();
  });

  it.each(['completed', 'cancelled', 'missingReceipt'] as const)('settles one admitted Account acquisition without postread policy: %s', async outcome => {
    const store = memoryStore();
    const selected = { service, accountId: 'selected' };
    const next = { service, accountId: 'next' };
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: selected } }] }));
    const readBindings = vi.spyOn(store, 'read');
    const cancellation = new AbortController();
    const captureCredentialRevision = vi.fn();
    const recordOperationCredentialUse = vi.fn();
    let readsAtAcquisition = 0;
    const { owner, materializeAccount } = createOwner({ store, credentialOwnerAccountId: 'owner',
      resolveTarget: accountTargetResolver(['selected', 'next']),
      materializeAccount: async ({ account, credentialRevisionBasis }) => {
        readsAtAcquisition = readBindings.mock.calls.length;
        await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: next } }] }));
        if (outcome === 'cancelled') cancellation.abort();
        if (outcome !== 'missingReceipt') credentialRevisionBasis?.captureCredentialRevision('csr_0123456789ABCDEFGHJKMNPQRS');
        return { kind: 'environment', env: { TOKEN: account.accountId } };
      },
    });
    const input = { ...authorized, expectedAccount: selected, signal: cancellation.signal,
      request: { kind: 'environment' as const, keys: ['TOKEN'] }, recordOperationCredentialUse,
      credentialRevisionBasis: { expectedCredentialRevision: null, captureCredentialRevision } };
    const result = owner.materialize(input);
    if (outcome === 'cancelled') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    else if (outcome === 'missingReceipt') await expect(result).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    else await expect(result).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'selected' } });
    expect(materializeAccount).toHaveBeenCalledOnce();
    expect(readBindings.mock.calls.length).toBe(readsAtAcquisition);
    if (outcome === 'completed') {
      expect(captureCredentialRevision).toHaveBeenCalledOnce();
      expect(captureCredentialRevision).toHaveBeenCalledWith('csr_0123456789ABCDEFGHJKMNPQRS');
      expect(recordOperationCredentialUse).toHaveBeenCalledOnce();
      expect(recordOperationCredentialUse).toHaveBeenCalledWith(expect.objectContaining({ label: 'Account selected' }));
      await expect(owner.materialize({ ...input, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
      expect(materializeAccount).toHaveBeenCalledOnce();
      await expect(owner.materialize({ ...input, expectedAccount: next, signal: new AbortController().signal }))
        .resolves.toEqual({ kind: 'environment', env: { TOKEN: 'next' } });
      expect(materializeAccount).toHaveBeenCalledTimes(2);
      expect(readBindings).toHaveBeenCalledTimes(3);
    } else {
      expect(captureCredentialRevision).not.toHaveBeenCalled();
      expect(recordOperationCredentialUse).not.toHaveBeenCalled();
    }
  });

  it('reads and updates a stored purpose catalog with retired nested fields', async () => {
    const store = memoryStore();
    await store.update(() => ({ v: 1, retiredCatalogField: true, bindings: [{
      retiredBindingField: true,
      purpose: { ...purpose, retiredPurposeField: true,
        consumer: { ...purpose.consumer, retiredConsumerField: true } },
      target: { kind: 'account', retiredTargetField: true,
        account: { service: { ...service, retiredServiceField: true }, accountId: 'saved' } },
    }] }));
    const { owner } = createOwner({ store });
    const signal = new AbortController().signal;
    await expect(owner.materialize({ ...authorized, signal,
      request: { kind: 'environment', keys: ['TOKEN'] },
    })).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'token:saved' } });
    await owner.requestSelection({ ...authorized, reason: 'explicit', signal });
    expect(store.current()).toEqual({ v: 1, bindings: [{ purpose, target: {
      kind: 'account', account: { service, accountId: 'fixed' },
    } }] });
  });

  it('materializes an unbound native service without persisting credentials and keeps explicit accounts authoritative', async () => {
    const materializeNative = vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer native-secret' } }));
    const { owner, store } = createOwner({
      materializeNative,
      materializeAccount: async ({ account }) => ({ kind: 'httpHeaders', headers: { authorization: `Bearer ${account.accountId}` } }),
    });
    const input = { ...authorized, nativeService: service, request: { kind: 'httpHeaders' as const, origin: 'https://api.example.test', headerNames: ['authorization'] }, signal: new AbortController().signal };
    await expect(owner.materialize(input)).resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer native-secret' } });
    expect(store.current()).toEqual({ v: 1, bindings: [] });
    await owner.requestSelection({ ...authorized, reason: 'explicit', signal: input.signal });
    await expect(owner.materialize(input)).resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixed' } });
    expect(materializeNative).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.current())).not.toContain('secret');
  });

  it('retires an unbound native read authority when its material changes', async () => {
    let nativeLogin = 'synthetic-login-first';
    const sourceChanges = new EventEmitter();
    const { owner, store } = createOwner({
      // Only the machine credential boundary is substituted. The real owner
      // must not prove native authority unchanged merely from two null bindings.
      materializeNative: async () => ({ kind: 'httpHeaders', headers: { authorization: nativeLogin } }),
      // Machine credential-change notifications are an external system boundary.
      subscribeInvalidations(listener) {
        sourceChanges.on('change', listener);
        return { dispose: () => { sourceChanges.off('change', listener); } };
      },
    });
    const input = { ...authorized, nativeService: service,
      request: { kind: 'httpHeaders' as const, origin: 'https://api.example.test', headerNames: ['authorization'] },
      signal: new AbortController().signal };
    const listener = vi.fn();
    const subscription = owner.watch({ ...authorized, listener });
    try {
      await expect(owner.getBinding(input)).resolves.toBeNull();
      await expect(owner.materialize(input)).resolves.toMatchObject({ headers: { authorization: 'synthetic-login-first' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      nativeLogin = 'synthetic-login-second';
      await expect(owner.materialize(input)).resolves.toMatchObject({ headers: { authorization: 'synthetic-login-second' } });
      // An unchanged persisted binding is distinct from native source authority.
      store.invalidate();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listener).not.toHaveBeenCalled();
      sourceChanges.emit('change');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ authorityChanged: true }));
    } finally { subscription.dispose(); }
  });

  it('preserves failed explicit intent through ordinary reads and repeated native materialization until explicitly cleared', async () => {
    let available = true;
    const materializeNative = vi.fn(async () => ({ kind: 'environment' as const, env: { TOKEN: 'native-secret' } }));
    const { owner, store } = createOwner({ materializeNative, resolveAvailable: () => available });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'explicit', signal });
    available = false;
    const nativeInput = { ...authorized, nativeService: service, request: { kind: 'environment' as const, keys: ['TOKEN'] }, signal };
    await expect(owner.materialize(nativeInput)).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    await expect(owner.listAccounts({ ...authorized, signal })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    await expect(owner.getBinding({ ...authorized, signal })).resolves.toBeNull();
    await expect(owner.materialize({ ...authorized, request: nativeInput.request, signal })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    await expect(owner.materialize(nativeInput)).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(store.current().bindings).toHaveLength(1);
    expect(materializeNative).not.toHaveBeenCalled();

    // The Account Settings writer explicitly clears the user's durable selection.
    await store.update((current) => ({ ...current, bindings: [] }), signal);
    await expect(owner.materialize(nativeInput)).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'native-secret' } });
    expect(store.current().bindings).toEqual([]);
  });

  it('preserves explicit intent for a still-declared purpose across service-scope contraction', async () => {
    const materializeNative = vi.fn(async () => ({ kind: 'environment' as const, env: { TOKEN: 'native-secret' } }));
    const { owner, store } = createOwner({ materializeNative });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'explicit', signal });
    await owner.reconcileAuthorizedPurposes({
      consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [{ purpose, serviceRefs: [otherService] }] }],
      signal,
      publish: () => undefined,
    });
    const contracted = { ...authorized, serviceRefs: [otherService], signal };
    await expect(owner.getBinding(contracted)).resolves.toBeNull();
    await expect(owner.materialize({ ...contracted, nativeService: otherService, request: { kind: 'environment', keys: ['TOKEN'] } })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(store.current().bindings).toHaveLength(1);
    expect(materializeNative).not.toHaveBeenCalled();
  });

  it('finishes admitted native material then observes a new explicit binding at the next acquisition', async () => {
    let finish!: () => void;
    const materializeNative = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { kind: 'environment' as const, env: { TOKEN: 'native-secret' } };
    });
    const { owner, store } = createOwner({ materializeNative,
      resolveTarget: createPurposeTargetResolver({ available: false,
        resolveService: async () => null, listAccounts: async () => [] }),
    });
    const signal = new AbortController().signal;
    const pending = owner.materialize({ ...authorized, nativeService: service, request: { kind: 'environment', keys: ['TOKEN'] }, signal });
    await vi.waitFor(() => expect(materializeNative).toHaveBeenCalledOnce());
    await store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'fixed' } } }] }));
    finish();
    await expect(pending).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'native-secret' } });
    await expect(owner.materialize({ ...authorized, nativeService: service,
      request: { kind: 'environment', keys: ['TOKEN'] }, signal }))
      .rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(materializeNative).toHaveBeenCalledOnce();
  });

  it('refuses native materialization outside service authority or with account revision preconditions', async () => {
    const materializeNative = vi.fn(async () => ({ kind: 'environment' as const, env: { TOKEN: 'native-secret' } }));
    const { owner } = createOwner({ materializeNative });
    const input = { ...authorized, request: { kind: 'environment' as const, keys: ['TOKEN'] }, signal: new AbortController().signal };
    await expect(owner.materialize({ ...input, nativeService: otherService })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    await expect(owner.materialize({ ...input, nativeService: service, expectedAccount: { service, accountId: 'fixed' } })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    await expect(owner.materialize({ ...input, nativeService: service, credentialRevisionBasis: { expectedCredentialRevision: null, captureCredentialRevision() {} } })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    expect(materializeNative).not.toHaveBeenCalled();
  });

  it('refuses native disclosure from a retired explicitly unbound operation subject', async () => {
    const materializeNative = vi.fn(async () => ({ kind: 'environment' as const, env: { TOKEN: 'native-secret' } }));
    const { owner } = createOwner({ materializeNative });
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: 'native-operation', consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose], bindings: [],
    });
    lease.dispose();
    await expect(owner.materialize({ ...authorized, exactPurposeBindingSubjectId: lease.subjectId, nativeService: service, request: { kind: 'environment', keys: ['TOKEN'] }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(materializeNative).not.toHaveBeenCalled();
  });

  it('materializes each widget Resource through that viewer own purpose selection and refuses a missing or revoked choice', async () => {
    const widgetPurpose = { consumer: { pluginId: 'acme.metrics', localId: 'metrics' }, purpose: 'read' };
    const viewers = await Promise.all(['A', 'B'].map(async accountId => {
      let available = true;
      const fixture = createOwner({ resolveAvailable: () => available });
      await fixture.store.update(() => ({ v: 1, bindings: [{ purpose: widgetPurpose, target: { kind: 'account', account: { service, accountId } } }] }));
      return { ...fixture, revoke: () => { available = false; fixture.store.invalidate(); } };
    }));
    const scope = { purpose: widgetPurpose, serviceRefs: [service], signal: new AbortController().signal };
    const read = (viewer: typeof viewers[number]) => viewer.owner.materialize({ ...scope, request: { kind: 'environment', keys: ['TOKEN'] } });
    expect(await read(viewers[0]!)).toEqual({ kind: 'environment', env: { TOKEN: 'token:A' } });
    expect(await read(viewers[1]!)).toEqual({ kind: 'environment', env: { TOKEN: 'token:B' } });
    viewers[1]!.revoke();
    await expect(read(viewers[1]!)).rejects.toBeInstanceOf(PluginError);
    expect(await read(viewers[0]!)).toEqual({ kind: 'environment', env: { TOKEN: 'token:A' } });
    await viewers[1]!.store.update(() => ({ v: 1, bindings: [] }));
    expect(await viewers[1]!.owner.getBinding(scope)).toBeNull();
    await expect(read(viewers[1]!)).rejects.toBeInstanceOf(PluginError);
  });
  it('composes one exact Agent + managed Provider session snapshot and rejects every overlap', () => {
    const managedPurpose = {
      consumer: { pluginId: 'happier.provider.test', localId: 'managed-runtime' },
      purpose: 'upstream-request',
    } as const;
    const agentBinding = {
      purpose,
      target: {
        kind: 'account' as const,
        account: { service, accountId: 'agent' },
      },
    };
    const managedBinding = {
      purpose: managedPurpose,
      target: {
        kind: 'account' as const,
        account: { service, accountId: 'managed' },
      },
    };

    expect(composeConnectedAccountSessionPurposeBindingSnapshot([
      { purposes: [purpose], bindings: [agentBinding] },
      { purposes: [managedPurpose], bindings: [managedBinding] },
    ])).toEqual({
      purposes: [purpose, managedPurpose],
      bindings: [agentBinding, managedBinding],
    });
    expect(() => composeConnectedAccountSessionPurposeBindingSnapshot([
      { purposes: [purpose], bindings: [agentBinding] },
      { purposes: [purpose], bindings: [agentBinding] },
    ])).toThrow('connected_account_session_binding_snapshot_duplicate_purpose');
    expect(() => composeConnectedAccountSessionPurposeBindingSnapshot([
      { purposes: [purpose], bindings: [agentBinding] },
      {
        purposes: [purpose],
        bindings: [{
          purpose,
          target: {
            kind: 'account',
            account: { service, accountId: 'conflicting' },
          },
        }],
      },
    ])).toThrow('connected_account_session_binding_snapshot_duplicate_purpose');
  });

  it('carries each composed snapshot\'s direct Team material origins into the session snapshot', () => {
    const managedPurpose = {
      consumer: { pluginId: 'happier.provider.test', localId: 'managed-runtime' },
      purpose: 'upstream-request',
    } as const;
    const teamMember = { service, accountId: 'team-member' };
    const agentBinding = {
      purpose,
      target: { kind: 'account' as const, account: teamMember },
    };
    const managedBinding = {
      purpose: managedPurpose,
      target: {
        kind: 'account' as const,
        account: { service, accountId: 'managed' },
      },
    };
    const origin = { purpose, resourceId: 'team-resource', disclosedMember: teamMember };

    const composed = composeConnectedAccountSessionPurposeBindingSnapshot([
      { purposes: [purpose], bindings: [agentBinding], directMaterialOrigins: [origin] },
      { purposes: [managedPurpose], bindings: [managedBinding] },
    ]);

    expect(composed.directMaterialOrigins).toEqual([origin]);
  });

  it('resolves one authorized logical intent without persisting or applying a group member', async () => {
    const { owner, store } = createOwner({
      resolveTarget: async (target) => target.kind === 'group'
        ? {
            displayName: `Group ${target.groupId}`,
            account: {
              service: target.service,
              accountId: 'alpha',
            },
          }
        : {
            displayName: `Account ${target.account.accountId}`,
            account: target.account,
          },
    });
    const signal = new AbortController().signal;

    await expect(owner.resolveBindingIntent({
      purpose,
      target: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
      },
      serviceRefs: [service],
      signal,
    })).resolves.toEqual({
      purpose,
      target: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
      },
    });
    expect(store.current().bindings).toEqual([]);

    await expect(owner.resolveBindingIntent({
      purpose,
      target: {
        kind: 'account',
        account: { service: otherService, accountId: 'forbidden' },
      },
      serviceRefs: [service],
      signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    });

    const unavailable = createOwner({ resolveAvailable: () => false });
    await expect(unavailable.owner.resolveBindingIntent({
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'removed' },
      },
      serviceRefs: [service],
      signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(unavailable.store.current().bindings).toEqual([]);
  });

  it('witnesses the exact member selected by a logical group intent and detects canonical reselection', async () => {
    let currentGroupAccountId = 'alpha';
    let targetReadFailure: Error | null = null;
    const { owner, store } = createOwner({ currentGroupAccountId: () => {
      if (targetReadFailure) throw targetReadFailure;
      return currentGroupAccountId;
    } });
    const caller = new AbortController();
    const signal = caller.signal;
    const selection = await owner.resolveBindingIntentSelection({
      purpose,
      target: { kind: 'group', service, groupId: 'fallbacks' },
      serviceRefs: [service],
      signal,
    });

    expect(selection).toMatchObject({
      binding: {
        purpose,
        target: { kind: 'group', service, groupId: 'fallbacks' },
      },
      resolved: {
        account: { service, accountId: 'alpha' },
      },
    });
    await expect(selection.isCurrent()).resolves.toBe(true);
    caller.abort();
    await expect(selection.isCurrent()).resolves.toBe(false);
    const retainedRead = new AbortController();
    await expect(selection.isCurrent(retainedRead.signal)).resolves.toBe(true);
    targetReadFailure = new Error('Home unavailable');
    await expect(selection.isCurrent(retainedRead.signal)).rejects.toBe(targetReadFailure);
    targetReadFailure = null;
    await expect(selection.isCurrent(retainedRead.signal)).resolves.toBe(true);
    currentGroupAccountId = 'beta';
    await expect(selection.isCurrent(retainedRead.signal)).resolves.toBe(false);
    expect(store.current().bindings).toEqual([]);
  });

  it('builds an immutable launch snapshot for a novel qualified service through the canonical selection owner', async () => {
    const externalPurpose = {
      consumer: { pluginId: 'acme.agent', localId: 'acme-agent' },
      purpose: 'primary',
    } as const;
    const externalService = {
      pluginId: 'acme.connected-account',
      localId: 'credential',
    } as const;
    const store = memoryStore();
    await store.update(() => ({
      v: 1,
      bindings: [{
        purpose: externalPurpose,
        target: {
          kind: 'group',
          service: externalService,
          groupId: 'external-fallbacks',
        },
      }],
    }));
    const { owner } = createOwner({
      store,
      resolveTarget: async (target) => target.kind === 'group'
        ? {
            displayName: 'External fallbacks',
            account: {
              service: target.service,
              accountId: 'current-external-account',
            },
          }
        : {
            displayName: `Account ${target.account.accountId}`,
            account: target.account,
          },
    });

    await expect(owner.resolveCurrentSessionPurposeBindingSnapshot({
      authorizedPurposes: [{
        purpose: externalPurpose,
        serviceRefs: [externalService],
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purposes: [externalPurpose],
      bindings: [{
        purpose: externalPurpose,
        target: {
          kind: 'group',
          service: externalService,
          groupId: 'external-fallbacks',
        },
      }],
      directMaterialOrigins: [],
      teamResourceSelections: [],
    });
  });

  it('resolves and materializes a manifest-qualified request-auth binding through the active canonical session owner', async () => {
    const externalPurpose = {
      consumer: { pluginId: 'acme.agent', localId: 'acme-agent' },
      purpose: 'primary',
    } as const;
    const externalService = {
      pluginId: 'acme.connected-account',
      localId: 'credential',
    } as const;
    const externalBinding = {
      purpose: externalPurpose,
      target: {
        kind: 'account' as const,
        account: {
          service: externalService,
          accountId: 'external-account',
        },
      },
    };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const { owner, materializeAccount } = createOwner({
      resolveCredentialRevision: async () => revision,
      materializeAccount: async ({ account, credentialRevisionBasis, request }) => {
        if (request.kind !== 'httpHeaders') {
          throw new Error('expected http header materialization');
        }
        credentialRevisionBasis?.captureCredentialRevision(revision);
        return {
          kind: 'httpHeaders',
          headers: {
            authorization: `Bearer ${account.accountId}-${revision}`,
            'x-account': account.accountId,
          },
        };
      },
    });
    const lease = owner.activateSessionPurposeBindings({
      sessionId: 'external-session',
      purposes: [externalPurpose],
      bindings: [externalBinding],
    });
    const signal = new AbortController().signal;

    const resolved = await owner.resolveCurrentRequestAuthBinding({
      subjectId: lease.subjectId,
      binding: externalBinding,
      signal,
    });
    expect(resolved).toEqual({
      account: externalBinding.target.account,
      credentialRevision: revision,
    });
    await expect(owner.materializeRequestAuthBearer({
      subjectId: lease.subjectId,
      binding: externalBinding,
      resolved: resolved!,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.example.test',
        headerNames: ['authorization', 'x-account'],
      },
      signal,
    })).resolves.toEqual({
      headers: { authorization: `Bearer external-account-${revision}`, 'x-account': 'external-account' },
      facts: {},
    });
    expect(materializeAccount).toHaveBeenCalledWith(expect.objectContaining({
      account: externalBinding.target.account,
      credentialRevisionBasis: expect.objectContaining({
        expectedCredentialRevision: revision,
      }),
    }));
    lease.dispose();
  });

  it.each(['current', 'revision_changed', 'invalid_headers'] as const)('records request-auth use only after final admission and header validation: %s', async outcome => {
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let reads = 0;
    const { owner } = createOwner({
      resolveCredentialRevision: async () => outcome === 'revision_changed' && ++reads >= 3 ? 'csr_abcdefghijklmnopqrstuv' : revision,
      materializeAccount: async ({ credentialRevisionBasis }) => {
        credentialRevisionBasis?.captureCredentialRevision(revision);
        return { kind: 'httpHeaders', headers: { authorization: outcome === 'invalid_headers' ? 'Bearer private-token\r\nInjected: invalid' : 'Bearer private-token' } };
      },
    });
    const recordOperationCredentialUse = vi.fn();
    const binding = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected' } } };
    const lease = owner.activatePurposeBindings({
      subject: { kind: 'operation', operationId: `request-auth-${outcome}`, consumer: purpose.consumer, isCurrent: () => true },
      purposes: [purpose], bindings: [binding], recordOperationCredentialUse,
    });
    const signal = new AbortController().signal;
    const resolved = await owner.resolveCurrentRequestAuthBinding({ subjectId: lease.subjectId, binding, signal });
    expect(resolved).not.toBeNull();
    const pending = owner.materializeRequestAuthBearer({ subjectId: lease.subjectId, binding, resolved: resolved!,
      materialization: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] }, signal });
    if (outcome === 'current') {
      await expect(pending).resolves.toEqual({ headers: { authorization: 'Bearer private-token' }, facts: {} });
      expect(recordOperationCredentialUse.mock.calls).toEqual([[{
        v: 1, kind: 'connected_account', label: 'Account selected', owner: null, service,
        why: { kind: 'purpose_binding', purpose, target: 'account' }, currentness: { kind: 'current_at_materialization' },
      }]]);
    } else {
      await expect(pending).rejects.toThrow();
      expect(recordOperationCredentialUse).not.toHaveBeenCalled();
    }
    lease.dispose();
  });

  it('uses one immutable session lease for bound and explicitly unbound launch purposes without changing durable defaults', async () => {
    const nativePurpose = {
      consumer: purpose.consumer,
      purpose: 'native-model-request',
    } as const;
    const { owner, store, materializeAccount } = createOwner({
      selected: {
        kind: 'account',
        account: { service, accountId: 'durable-default' },
      },
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose durable default',
      signal,
    });

    const sessionBinding = {
      purpose,
      target: {
        kind: 'account' as const,
        account: { service, accountId: 'launch-account' },
      },
    };
    const lease = owner.activateSessionPurposeBindings({
      sessionId: 'session-1',
      purposes: [purpose, nativePurpose],
      bindings: [sessionBinding],
    });

    expect(lease.isCurrent()).toBe(true);
    expect(lease.resolvePurposeBinding(purpose)).toEqual(sessionBinding);
    expect(lease.resolvePurposeBinding(nativePurpose)).toBeNull();
    expect(lease.listPurposeBindings()).toEqual([sessionBinding]);
    await expect(owner.getBinding({
      ...authorized,
      sessionId: 'session-1',
      signal,
    })).resolves.toMatchObject({
      target: { displayName: 'Account launch-account' },
    });
    await expect(owner.getBinding({
      purpose: nativePurpose,
      serviceRefs: [service],
      sessionId: 'session-1',
      signal,
    })).resolves.toBeNull();
    await expect(owner.materialize({
      ...authorized,
      sessionId: 'session-1',
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal,
    })).resolves.toEqual({
      kind: 'environment',
      env: { TOKEN: 'token:launch-account' },
    });
    expect(materializeAccount).toHaveBeenLastCalledWith(expect.objectContaining({
      account: { service, accountId: 'launch-account' },
    }));
    await expect(owner.getBinding({ ...authorized, signal })).resolves.toMatchObject({
      target: { displayName: 'Account durable-default' },
    });
    expect(store.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'durable-default' },
      },
    }]);

    lease.dispose();
    expect(lease.isCurrent()).toBe(false);
    expect(lease.resolvePurposeBinding(purpose)).toBeNull();
    expect(lease.listPurposeBindings()).toEqual([]);
    await expect(owner.getBinding({
      ...authorized,
      sessionId: 'session-1',
      signal,
    })).resolves.toMatchObject({
      target: { displayName: 'Account durable-default' },
    });
  });

  it('owns an execution run by one typed run identity and invalidates the immutable snapshot with its exact lifecycle', () => {
    const { owner } = createOwner();
    const binding = {
      purpose,
      target: {
        kind: 'group' as const,
        service,
        groupId: 'run-group',
      },
    };
    let exactRunCurrent = true;
    const lease = owner.activatePurposeBindings({
      subject: {
        kind: 'execution_run',
        runId: 'run-1',
        runnerPid: 4242,
        agentId: 'codex',
        isCurrent: () => exactRunCurrent,
      },
      purposes: [purpose],
      bindings: [binding],
    });

    expect(lease.subjectId).toBe(
      'execution-run:run-1/runner:4242/agent:codex',
    );
    expect(lease.isCurrent()).toBe(true);
    expect(lease.resolvePurposeBinding(purpose)).toEqual(binding);
    expect(() => owner.activatePurposeBindings({
      subject: {
        kind: 'execution_run',
        runId: 'run-1',
        runnerPid: 4343,
        agentId: 'pi',
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings: [binding],
    })).toThrow('connected_account_execution_run_binding_already_active');

    exactRunCurrent = false;
    expect(lease.isCurrent()).toBe(false);
    expect(lease.resolvePurposeBinding(purpose)).toBeNull();
    expect(lease.listPurposeBindings()).toEqual([]);

    lease.dispose();
    const replacement = owner.activatePurposeBindings({
      subject: {
        kind: 'execution_run',
        runId: 'run-1',
        runnerPid: 4343,
        agentId: 'pi',
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings: [binding],
    });
    expect(replacement.isCurrent()).toBe(true);
    replacement.dispose();
  });

  it.each(['configuration-1', null, undefined])('reads one managed Provider operation from its immutable subject and retains configuration basis %s', async revision => {
    const store = memoryStore();
    await store.update(() => ({
      v: 1,
      bindings: [{
        purpose,
        target: {
          kind: 'account',
          account: { service, accountId: 'durable-default' },
        },
      }],
    }));
    let currentRevision = revision ?? null;
    const { owner, materializeAccount } = createOwner({ store, materializeAccount: async input => {
      // The external credential transport rejects a changed admitted configuration.
      if (input.expectedConfigurationRevision !== undefined && input.expectedConfigurationRevision !== currentRevision) {
        throw new Error('configuration_changed');
      }
      return { kind: 'environment', env: { TOKEN: `token:${input.account.accountId}` } };
    } });
    let operationCurrent = true;
    const lease = owner.activatePurposeBindings({
      subject: {
        kind: 'managed_provider_operation',
        operationId: 'catalog-probe-1',
        pluginId: purpose.consumer.pluginId,
        providerLocalId: purpose.consumer.localId,
        credentialConfigurations: [
          { account: { service: otherService, accountId: 'captured-operation' }, revision: 'other-service-configuration' },
          ...(revision === undefined ? [] : [{ account: { service, accountId: 'captured-operation' }, revision }]),
        ],
        isCurrent: () => operationCurrent,
      },
      purposes: [purpose],
      bindings: [{
        purpose,
        target: {
          kind: 'account',
          account: { service, accountId: 'captured-operation' },
        },
      }],
    });
    const exact = {
      ...authorized,
      exactPurposeBindingSubjectId: lease.subjectId,
      signal: new AbortController().signal,
    };

    await expect(owner.getBinding(exact)).resolves.toMatchObject({
      target: { displayName: 'Account captured-operation' },
    });
    await expect(owner.materialize({
      ...exact,
      request: { kind: 'environment', keys: ['TOKEN'] },
    })).resolves.toEqual({
      kind: 'environment',
      env: { TOKEN: 'token:captured-operation' },
    });
    expect(materializeAccount).toHaveBeenCalledWith(expect.objectContaining({
      account: { service, accountId: 'captured-operation' },
    }));

    currentRevision = 'changed-configuration';
    const changed = owner.materialize({ ...exact, request: { kind: 'environment', keys: ['TOKEN'] } });
    if (revision === undefined) {
      await expect(changed).resolves.toMatchObject({ kind: 'environment' });
    } else await expect(changed).rejects.toThrow('configuration_changed');

    operationCurrent = false;
    await expect(owner.getBinding(exact)).resolves.toBeNull();
    await expect(owner.materialize({
      ...exact,
      request: { kind: 'environment', keys: ['TOKEN'] },
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    lease.dispose();
  });

  it('scopes one target-operation subject to its exact consumer and removes it at settlement', async () => {
    const store = memoryStore();
    await store.update(() => ({
      v: 1,
      bindings: [{
        purpose,
        target: {
          kind: 'account',
          account: { service, accountId: 'durable-default' },
        },
      }],
    }));
    const { owner, materializeAccount } = createOwner({ store });
    const lease = owner.activatePurposeBindings({
      subject: {
        kind: 'operation',
        operationId: 'target-action-correlation-1',
        consumer: purpose.consumer,
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings: [{
        purpose,
        target: {
          kind: 'account',
          account: { service, accountId: 'target-action-account' },
        },
      }],
    });
    const exact = {
      ...authorized,
      exactPurposeBindingSubjectId: lease.subjectId,
      signal: new AbortController().signal,
    };

    expect(lease.subjectId).toBe(
      'operation:target-action-correlation-1/consumer:happier.agent.test/runtime',
    );
    await expect(owner.materialize({
      ...exact,
      request: { kind: 'environment', keys: ['TOKEN'] },
    })).resolves.toMatchObject({
      env: { TOKEN: 'token:target-action-account' },
    });
    expect(materializeAccount).toHaveBeenLastCalledWith(expect.objectContaining({
      account: { service, accountId: 'target-action-account' },
    }));

    lease.dispose();
    await expect(owner.getBinding(exact)).resolves.toBeNull();
    await expect(owner.materialize({
      ...exact,
      request: { kind: 'environment', keys: ['TOKEN'] },
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(materializeAccount).toHaveBeenCalledTimes(1);
  });

  it('scopes a transient Agent catalog observation to its exact contribution consumer and currentness', () => {
    const { owner } = createOwner();
    let current = true;
    const lease = owner.activatePurposeBindings({
      subject: {
        kind: 'agent_catalog_observation',
        operationId: 'observation-1',
        consumer: purpose.consumer,
        isCurrent: () => current,
      },
      purposes: [purpose],
      bindings: [{
        purpose,
        target: { kind: 'account', account: { service, accountId: 'selected' } },
      }],
    });

    expect(lease.resolvePurposeBinding(purpose)).toMatchObject({
      target: { kind: 'account', account: { accountId: 'selected' } },
    });
    current = false;
    expect(lease.resolvePurposeBinding(purpose)).toBeNull();
    lease.dispose();

    expect(() => owner.activatePurposeBindings({
      subject: {
        kind: 'agent_catalog_observation',
        operationId: 'observation-2',
        consumer: purpose.consumer,
        isCurrent: () => true,
      },
      purposes: [{
        consumer: { pluginId: purpose.consumer.pluginId, localId: 'other-agent' },
        purpose: purpose.purpose,
      }],
      bindings: [],
    })).toThrow('connected_account_agent_catalog_observation_binding_consumer_mismatch');
  });

  it('persists one qualified binding selected within the authorized service scope', async () => {
    const { owner, store } = createOwner();
    const signal = new AbortController().signal;

    await expect(owner.getBinding({ ...authorized, signal })).resolves.toBeNull();
    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose model auth',
      signal,
    })).resolves.toEqual({
      purpose: 'model-request',
      service,
      account: { service, accountId: 'fixed' },
      target: { kind: 'account', displayName: 'Account fixed' },
    });
    expect(store.current()).toEqual({
      v: 1,
      bindings: [{
        purpose,
        target: { kind: 'account', account: { service, accountId: 'fixed' } },
      }],
    });
  });

  it('rejects a selector result outside the authorized services without persisting it', async () => {
    const { owner, store } = createOwner({
      selected: {
        kind: 'account',
        account: { service: otherService, accountId: 'forbidden' },
      },
    });

    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose model auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    expect(store.current().bindings).toEqual([]);
  });

  it('does not persist a selection when the consumer generation retires while selection is pending', async () => {
    let releaseSelection!: () => void;
    let markSelectionStarted!: () => void;
    const selectionStarted = new Promise<void>((resolve) => {
      markSelectionStarted = resolve;
    });
    const selectionReleased = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const { owner, store } = createOwner({
      selectTarget: async () => {
        markSelectionStarted();
        await selectionReleased;
        return {
          kind: 'account',
          account: { service, accountId: 'fixed' },
        };
      },
    });
    let generationCurrent = true;
    const request = owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent() {
        if (!generationCurrent) {
          throw new PluginError({
            code: 'plugin_final_generation_retired',
            message: 'Plugin generation retired during selection',
          });
        }
      },
      reason: 'Choose model auth',
      signal: new AbortController().signal,
    });

    await selectionStarted;
    generationCurrent = false;
    releaseSelection();

    await expect(request).rejects.toMatchObject({
      code: 'plugin_final_generation_retired',
    });
    expect(store.current().bindings).toEqual([]);
  });

  it('serializes selection commit compensation so a retired generation cannot overwrite a waiting newer selection', async () => {
    const store = memoryStore();
    let releaseFirstCommit!: () => void;
    let markFirstMutationEvaluated!: () => void;
    const firstMutationEvaluated = new Promise<void>((resolve) => {
      markFirstMutationEvaluated = resolve;
    });
    const firstCommitReleased = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let updateCount = 0;
    const delayedStore: ReturnType<typeof memoryStore> = {
      ...store,
      async update(mutate, signal) {
        updateCount += 1;
        if (updateCount === 1) {
          const staged = mutate(store.current());
          markFirstMutationEvaluated();
          await firstCommitReleased;
          return await store.update(() => staged, signal);
        }
        return await store.update(mutate, signal);
      },
    };
    let selectionCount = 0;
    const { owner } = createOwner({
      store: delayedStore,
      selectTarget: async () => ({
        kind: 'account',
        account: {
          service,
          accountId: selectionCount++ === 0 ? 'retired' : 'current',
        },
      }),
    });
    let oldGenerationCurrent = true;
    const oldSelection = owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent() {
        if (!oldGenerationCurrent) {
          throw new PluginError({
            code: 'plugin_final_generation_retired',
            message: 'Old generation retired during persistence',
          });
        }
      },
      reason: 'Choose from old generation',
      signal: new AbortController().signal,
    });
    await firstMutationEvaluated;
    oldGenerationCurrent = false;

    const newSelection = owner.requestSelection({
      ...authorized,
      reason: 'Choose from new generation',
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    expect(updateCount).toBe(1);

    releaseFirstCommit();
    await expect(oldSelection).rejects.toMatchObject({
      code: 'plugin_final_generation_retired',
    });
    await expect(newSelection).resolves.toMatchObject({
      target: { kind: 'account', displayName: 'Account current' },
    });
    expect(store.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'current' },
      },
    }]);
  });

  it('does not value-restore a prior target after another writer reselects the retired target', async () => {
    const store = memoryStore();
    const priorTarget = {
      kind: 'account' as const,
      account: { service, accountId: 'prior' },
    };
    const retiredTarget = {
      kind: 'account' as const,
      account: { service, accountId: 'candidate' },
    };
    const interveningTarget = {
      kind: 'account' as const,
      account: { service, accountId: 'intervening' },
    };
    await store.update(() => ({
      v: 1,
      bindings: [{ purpose, target: priorTarget }],
    }));
    let generationCurrent = true;
    let updateCount = 0;
    const interleavingStore: ReturnType<typeof memoryStore> = {
      ...store,
      async update(mutate, signal) {
        updateCount += 1;
        if (updateCount !== 1) return await store.update(mutate, signal);

        const staged = mutate(store.current());
        await store.update(() => staged, signal);
        // A concurrent Account Settings winner may replace and later reselect
        // the same target while this request awaits its durable settlement.
        await store.update(() => ({
          v: 1,
          bindings: [{ purpose, target: interveningTarget }],
        }), signal);
        await store.update(() => ({
          v: 1,
          bindings: [{ purpose, target: retiredTarget }],
        }), signal);
        generationCurrent = false;
        return store.current();
      },
    };
    const { owner } = createOwner({
      store: interleavingStore,
      selected: retiredTarget,
    });

    await expect(owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent() {
        if (!generationCurrent) {
          throw new PluginError({
            code: 'plugin_final_generation_retired',
            message: 'Selection retired after another writer reselected its target',
          });
        }
      },
      reason: 'Choose from retired generation',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_final_generation_retired',
    });
    expect(store.current().bindings).toEqual([{
      purpose,
      target: retiredTarget,
    }]);
  });

  it('restores the prior durable target when its replacement cannot resolve', async () => {
    let selectedAccountId = 'prior';
    let available = true;
    const { owner, store } = createOwner({
      selectTarget: async () => ({
        kind: 'account',
        account: { service, accountId: selectedAccountId },
      }),
      resolveAvailable: () => available,
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'Choose prior', signal });

    selectedAccountId = 'replacement';
    available = false;
    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose unavailable replacement',
      signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });

    expect(store.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'prior' },
      },
    }]);
  });

  it('revalidates an unavailable target so a later same-target reselection can resolve', async () => {
    let resolveCount = 0;
    let markStaleResolveStarted!: () => void;
    const staleResolveStarted = new Promise<void>((resolve) => {
      markStaleResolveStarted = resolve;
    });
    let releaseStaleResolve!: () => void;
    const staleResolveReleased = new Promise<void>((resolve) => {
      releaseStaleResolve = resolve;
    });
    const selected = {
      kind: 'account' as const,
      account: { service, accountId: 'same-target' },
    };
    const { owner, store } = createOwner({
      selected,
      resolveTarget: async (target) => {
        resolveCount += 1;
        if (resolveCount === 2) {
          markStaleResolveStarted();
          await staleResolveReleased;
          return null;
        }
        return {
          displayName: 'Same target',
          account: target.kind === 'account'
            ? target.account
            : { service: target.service, accountId: 'same-target' },
        };
      },
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'Seed same target', signal });

    const staleRead = owner.getBinding({ ...authorized, signal });
    await staleResolveStarted;
    await store.update((current) => ({
      v: 1,
      bindings: current.bindings.map((binding) => ({
        purpose: binding.purpose,
        target: binding.target,
      })),
    }));
    releaseStaleResolve();

    await expect(staleRead).resolves.toEqual({
      purpose: purpose.purpose,
      service,
      account: { service, accountId: 'same-target' },
      target: { kind: 'account', displayName: 'Same target' },
    });
    expect(store.current().bindings).toEqual([{
      purpose,
      target: selected,
    }]);
  });

  it('resolves a group current member for every materialization and stores no member or generation', async () => {
    let currentAccountId = 'alpha';
    const { owner, store, materializeAccount } = createOwner({
      selected: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
      },
      currentGroupAccountId: () => currentAccountId,
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'Choose fallback group', signal });

    const first = await owner.materialize({
      ...authorized,
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal,
    });
    currentAccountId = 'beta';
    const second = await owner.materialize({
      ...authorized,
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal,
    });

    expect(first).toEqual({ kind: 'environment', env: { TOKEN: 'token:alpha' } });
    expect(second).toEqual({ kind: 'environment', env: { TOKEN: 'token:beta' } });
    expect(materializeAccount.mock.calls.map(([call]) => call.account.accountId))
      .toEqual(['alpha', 'beta']);
    expect(JSON.stringify(store.current())).not.toContain('alpha');
    expect(JSON.stringify(store.current())).not.toContain('beta');
    expect(JSON.stringify(store.current())).not.toContain('generation');
  });

  it('publishes the exact currently resolved account beside a group binding summary', async () => {
    let currentAccountId = 'bot:123';
    const { owner } = createOwner({
      selected: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
      },
      currentGroupAccountId: () => currentAccountId,
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose fallback group',
      signal,
    });

    await expect(owner.getBinding({ ...authorized, signal })).resolves.toEqual({
      purpose: purpose.purpose,
      service,
      target: { kind: 'group', displayName: 'Group fallbacks' },
      account: { service, accountId: 'bot:123' },
    });

  });

  it('rejects a mismatched or stale expected account before materialization', async () => {
    let currentAccountId = 'bot:123';
    const { owner, materializeAccount } = createOwner({
      selected: {
        kind: 'group',
        service,
        groupId: 'fallbacks',
      },
      currentGroupAccountId: () => currentAccountId,
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose fallback group',
      signal,
    });

    await expect(owner.materialize({
      ...authorized,
      expectedAccount: { service, accountId: 'bot:other' },
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(materializeAccount).not.toHaveBeenCalled();

    currentAccountId = 'bot:other';
    await expect(owner.materialize({
      ...authorized,
      expectedAccount: { service, accountId: 'bot:123' },
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(materializeAccount).not.toHaveBeenCalled();
  });

  it('opens the admitted group Account and observes a switched member at the next acquisition', async () => {
    const profiles = accountProfiles(['alpha', 'beta']);
    let group: QualifiedConnectedAccountGroupV4 = { v: 1, ref: { service, groupId: 'fallbacks' },
      incarnation: 'group-row', displayName: 'Fallbacks', policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
      activeConnectedAccountId: 'alpha', generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
      members: ['alpha', 'beta'].map((connectedAccountId, index) => ({ v: 1 as const, connectedAccountId,
        priority: index + 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    };
    let markMaterializationStarted!: () => void;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization!: () => void;
    const materializationReleased = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const { owner, materializeAccount } = createOwner({
      selected: { kind: 'group', service, groupId: 'fallbacks' },
      resolveTarget: createPurposeTargetResolver({ available: true,
        resolveService: async () => ({ service, authentication: testAuthentication }),
        listAccounts: async () => profiles, readGroup: async () => group,
      }),
      materializeAccount: async ({ account, request }) => {
        markMaterializationStarted();
        await materializationReleased;
        if (request.kind !== 'environment') throw new Error('test only supports environment');
        return { kind: 'environment', env: { TOKEN: `token:${account.accountId}` } };
      },
    });
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose fallback group',
      signal,
    });
    const externalOpen = vi.fn();
    const openWithCapturedBinding = async (): Promise<void> => {
      const binding = await owner.getBinding({ ...authorized, signal });
      if (!binding) throw new Error('Expected an Account A binding');
      const material = await owner.materialize({
        ...authorized,
        expectedAccount: binding.account,
        request: { kind: 'environment', keys: ['TOKEN'] },
        signal,
      });
      externalOpen({ account: binding.account, material });
    };

    const pending = openWithCapturedBinding();
    await materializationStarted;
    group = { ...group, activeConnectedAccountId: 'beta', generation: 2 };
    releaseMaterialization();

    await expect(pending).resolves.toBeUndefined();
    expect(externalOpen).toHaveBeenCalledOnce();
    expect(externalOpen).toHaveBeenCalledWith({ account: { service, accountId: 'alpha' },
      material: { kind: 'environment', env: { TOKEN: 'token:alpha' } } });
    await expect(owner.materialize({ ...authorized, expectedAccount: { service, accountId: 'alpha' },
      request: { kind: 'environment', keys: ['TOKEN'] }, signal }))
      .rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(materializeAccount).toHaveBeenCalledOnce();
    await expect(owner.materialize({ ...authorized, expectedAccount: { service, accountId: 'beta' },
      request: { kind: 'environment', keys: ['TOKEN'] }, signal }))
      .resolves.toEqual({ kind: 'environment', env: { TOKEN: 'token:beta' } });
  });

  it('does not treat a legacy account field as selection authority', async () => {
    const { owner, materializeAccount } = createOwner();
    const signal = new AbortController().signal;
    const call = Reflect.apply(owner.materialize, owner, [Object.freeze({
      ...authorized,
      account: Object.freeze({ service, accountId: 'exact' }),
      request: Object.freeze({ kind: 'environment' as const, keys: ['TOKEN'] }),
      signal,
    })]);

    await expect(call).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(materializeAccount).not.toHaveBeenCalled();
  });

  it('finishes admitted operation material and refuses unavailable metadata at the next acquisition', async () => {
    let retiredAvailable = true;
    let markMaterializationStarted!: () => void;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization!: () => void;
    const materializationReleased = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const profiles = accountProfiles(['retired']);
    const { owner, materializeAccount } = createOwner({
      resolveTarget: createPurposeTargetResolver({ available: true,
        resolveService: async () => ({ service, authentication: testAuthentication }),
        listAccounts: async () => retiredAvailable ? profiles : [],
      }),
      materializeAccount: async ({ account, request }) => {
        markMaterializationStarted();
        await materializationReleased;
        if (request.kind !== 'environment') throw new Error('test only supports environment');
        return {
          kind: 'environment',
          env: { TOKEN: `token:${account.accountId}` },
        };
      },
    });
    const lease = owner.activatePurposeBindings({
      subject: {
        kind: 'operation',
        operationId: 'retired-target-attempt',
        consumer: purpose.consumer,
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings: [{
        purpose,
        target: { kind: 'account', account: { service, accountId: 'retired' } },
      }],
    });
    const input = {
      ...authorized,
      exactPurposeBindingSubjectId: lease.subjectId,
      request: { kind: 'environment' as const, keys: ['TOKEN'] },
      signal: new AbortController().signal,
    };
    const pending = owner.materialize(input);
    await materializationStarted;
    retiredAvailable = false;
    releaseMaterialization();

    await expect(pending).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'token:retired' } });
    await expect(owner.materialize(input)).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(materializeAccount).toHaveBeenCalledOnce();
    expect(materializeAccount).toHaveBeenCalledWith(expect.objectContaining({
      account: { service, accountId: 'retired' },
    }));
    lease.dispose();
  });

  it('fails materialization closed when unbound and watches only changes to its own purpose', async () => {
    const store = memoryStore();
    const { owner } = createOwner({ store, resolveCredentialRevision: async () => 'csr_abcdefghijklmnopqrstuv' });
    const listener = vi.fn();
    const subscription = owner.watch({ ...authorized, listener });

    await expect(owner.materialize({
      ...authorized,
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });

    store.invalidate();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(listener).not.toHaveBeenCalled();
    await owner.requestSelection({ ...authorized, reason: 'Select account', signal: new AbortController().signal });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await store.update(current => ({ ...current, bindings: [...current.bindings, {
      purpose: { ...purpose, purpose: 'another-purpose' },
      target: { kind: 'account', account: { service, accountId: 'other' } },
    }] }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(listener).toHaveBeenCalledOnce();
    subscription.dispose();
    store.invalidate();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('distinguishes selected credential authority from profile presentation and unrelated profiles', async () => {
    const store = memoryStore();
    let selected: QualifiedConnectedAccountProfileV4 = {
      ref: { service, accountId: 'fixed' }, revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv', configurationRevision: 'configuration-one',
      authenticationModeId: 'token', configurationReady: true, status: 'connected', scopes: ['read'],
      displayName: 'Personal',
    };
    let peer: QualifiedConnectedAccountProfileV4 = { ...selected, ref: { service, accountId: 'peer' } };
    const { owner } = createOwner({ store, resolveTarget: async () => ({
      account: selected.ref, displayName: selected.displayName ?? 'Selected',
      observation: { authentication: testAuthentication, profiles: [selected, peer] },
    }) });
    await owner.requestSelection({ ...authorized, reason: 'Select account', signal: new AbortController().signal });
    const listener = vi.fn();
    const subscription = owner.watch({ ...authorized, listener });
    const invalidate = async () => {
      listener.mockClear();
      store.invalidate();
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      await invalidate();
      expect(listener).not.toHaveBeenCalled();
      selected = { ...selected, displayName: 'Renamed', lastUsedAt: 123,
        providerIdentity: { email: 'new-label@example.test' } };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ account: selected.ref, authorityChanged: false });
      peer = { ...peer, credentialRevision: 'csr_bcdefghijklmnopqrstuvw' };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: false });
      peer = { ...peer, revisionSemantics: 'legacy_unfenced', credentialRevision: null };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: false });
      selected = { ...selected, credentialRevision: 'csr_bcdefghijklmnopqrstuvw' };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
      selected = { ...selected, configurationRevision: 'configuration-two' };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
      selected = { ...selected, scopes: ['read', 'write'], configurationRevision: 'configuration-three' };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
      selected = { ...selected, revisionSemantics: 'legacy_unfenced', credentialRevision: null };
      await invalidate();
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
    } finally { subscription.dispose(); }
  });

  it('fails watch authority closed when selected credentials are unversioned or resolution fails', async () => {
    const store = memoryStore();
    let available = true;
    const { owner } = createOwner({ store, resolveTarget: async () => {
      if (!available) throw new Error('source unavailable');
      return { account: { service, accountId: 'fixed' }, displayName: 'Selected' };
    } });
    await owner.requestSelection({ ...authorized, reason: 'Select account', signal: new AbortController().signal });
    const listener = vi.fn();
    const subscription = owner.watch({ ...authorized, listener });
    try {
      store.invalidate();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
      available = false;
      listener.mockClear();
      store.invalidate();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ authorityChanged: true });
    } finally { subscription.dispose(); }
  });

  it('retains a persisted selection when its account is unavailable', async () => {
    let available = true;
    const { owner, store } = createOwner({ resolveAvailable: () => available });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'Choose account', signal });
    expect(store.current().bindings).toHaveLength(1);

    available = false;
    await expect(owner.getBinding({ ...authorized, signal })).resolves.toBeNull();
    expect(store.current().bindings).toHaveLength(1);
  });

  it('does not leave a selected target persisted when immediate resolution fails', async () => {
    const { owner, store } = createOwner({ resolveAvailable: () => false });
    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose removed account',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
    expect(store.current().bindings).toEqual([]);
  });

  it('atomically removes a purpose at generation adoption so re-adding it cannot resurrect its stale selection', async () => {
    const { owner, store } = createOwner();
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal,
    });
    expect(store.current().bindings).toHaveLength(1);

    await owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      signal,
      publish: () => undefined,
    });
    expect(store.current().bindings).toEqual([]);

    await owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [{
          purpose,
          serviceRefs: [service],
        }],
      }],
      signal,
      publish: () => undefined,
    });
    await expect(owner.getBinding({ ...authorized, signal })).resolves.toBeNull();
  });

  it('preserves selections for still-declared purposes when their service scope changes', async () => {
    const store = memoryStore();
    const first = createOwner({ store });
    const secondPurpose = {
      consumer: purpose.consumer,
      purpose: 'embedding-request',
    } as const;
    const signal = new AbortController().signal;
    await first.owner.requestSelection({
      ...authorized,
      reason: 'Choose model account',
      signal,
    });
    await first.owner.requestSelection({
      purpose: secondPurpose,
      serviceRefs: [service],
      assertGenerationCurrent: () => undefined,
      reason: 'Choose embedding account',
      signal,
    });

    await first.owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [{
          purpose,
          serviceRefs: [service],
        }, {
          purpose: secondPurpose,
          serviceRefs: [otherService],
        }],
      }],
      signal,
      publish: () => undefined,
    });

    expect(store.current().bindings).toEqual([{
      purpose: secondPurpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'fixed' },
      },
    }, {
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'fixed' },
      },
    }]);
  });

  it('validates the complete reconciliation batch before its single store update', async () => {
    const store = memoryStore();
    const update = vi.fn(store.update);
    const { owner } = createOwner({ store: { ...store, update } });
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal,
    });
    update.mockClear();

    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }, {
        consumer: {
          pluginId: 'happier.agent.other',
          localId: 'runtime',
        },
        authorizedPurposes: [{
          // Invalid: this purpose belongs to the first consumer.
          purpose,
          serviceRefs: [service],
        }],
      }],
      signal,
      publish: () => undefined,
    })).rejects.toThrow(
      'connected_account_purpose_reconciliation_consumer_mismatch',
    );
    expect(update).not.toHaveBeenCalled();
    expect(store.current().bindings).toHaveLength(1);

    await owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }, {
        consumer: {
          pluginId: 'happier.agent.other',
          localId: 'runtime',
        },
        authorizedPurposes: [],
      }],
      signal,
      publish: () => undefined,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(store.current().bindings).toEqual([]);
  });

  it('returns committed when cancellation arrives after the reconciliation store mutation commits', async () => {
    const store = memoryStore();
    const seeded = createOwner({ store });
    const controller = new AbortController();
    await seeded.owner.requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: controller.signal,
    });
    const committingStore: ReturnType<typeof memoryStore> = {
      ...store,
      async update(mutate) {
        const committed = await store.update(mutate);
        controller.abort(new Error('candidate retired after durable commit'));
        return committed;
      },
    };
    const { owner } = createOwner({ store: committingStore });

    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      signal: controller.signal,
      publish: () => undefined,
    })).resolves.toBeUndefined();
    expect(store.current().bindings).toEqual([]);
    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose after committed cancellation',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      target: { kind: 'account', displayName: 'Account fixed' },
    });
  });

  it('releases consumer mutation serialization when the required non-throwing publication callback violates its contract', async () => {
    const { owner, store } = createOwner();
    const signal = new AbortController().signal;
    await owner.requestSelection({
      ...authorized,
      reason: 'Choose before publication',
      signal,
    });

    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      signal,
      publish() {
        throw new Error('test publication failure');
      },
    })).rejects.toThrow('test publication failure');
    expect(store.current().bindings).toEqual([]);
    await expect(owner.requestSelection({
      ...authorized,
      reason: 'Choose after publication failure',
      signal,
    })).resolves.toMatchObject({
      target: { kind: 'account', displayName: 'Account fixed' },
    });
  });

  it('publishes the candidate before releasing a queued retired-generation selection', async () => {
    const store = memoryStore();
    let releaseReconciliationCommit!: () => void;
    let markReconciliationMutated!: () => void;
    const reconciliationMutated = new Promise<void>((resolve) => {
      markReconciliationMutated = resolve;
    });
    const reconciliationCommitReleased = new Promise<void>((resolve) => {
      releaseReconciliationCommit = resolve;
    });
    let updateCount = 0;
    const delayedStore: ReturnType<typeof memoryStore> = {
      ...store,
      async update(mutate, signal) {
        updateCount += 1;
        const staged = mutate(store.current());
        if (updateCount === 1) {
          markReconciliationMutated();
          await reconciliationCommitReleased;
        }
        return await store.update(() => staged, signal);
      },
    };
    let releaseSelection!: () => void;
    let markSelectionStarted!: () => void;
    const selectionStarted = new Promise<void>((resolve) => {
      markSelectionStarted = resolve;
    });
    const selectionReleased = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const { owner } = createOwner({
      store: delayedStore,
      selectTarget: async () => {
        markSelectionStarted();
        await selectionReleased;
        return {
          kind: 'account',
          account: { service, accountId: 'retired' },
        };
      },
    });
    let oldGenerationCurrent = true;
    let published = false;
    const oldSelection = owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent() {
        if (!oldGenerationCurrent) {
          throw new PluginError({
            code: 'plugin_final_generation_retired',
            message: 'Old generation retired by registry publication',
          });
        }
      },
      reason: 'Choose from old generation',
      signal: new AbortController().signal,
    });
    await selectionStarted;
    const reconciliation = owner.reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      signal: new AbortController().signal,
      publish() {
        oldGenerationCurrent = false;
        published = true;
      },
    });
    await reconciliationMutated;
    releaseSelection();
    await Promise.resolve();
    expect(updateCount).toBe(1);
    expect(published).toBe(false);

    releaseReconciliationCommit();
    await reconciliation;
    expect(published).toBe(true);
    await expect(oldSelection).rejects.toMatchObject({
      code: 'plugin_final_generation_retired',
    });
    expect(updateCount).toBe(1);
    expect(store.current().bindings).toEqual([]);
  });

  it('refuses a durable selection outside the current service scope without mutating it', async () => {
    const store = memoryStore();
    const initial = createOwner({ store });
    const signal = new AbortController().signal;
    await initial.owner.requestSelection({
      ...authorized,
      reason: 'Choose the original account',
      signal,
    });

    await expect(initial.owner.getBinding({
      purpose,
      serviceRefs: [otherService],
      signal,
    })).resolves.toBeNull();
    expect(store.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: { service, accountId: 'fixed' },
      },
    }]);
    await expect(initial.owner.getBinding({ ...authorized, signal })).resolves.toEqual({
      purpose: purpose.purpose,
      service,
      account: { service, accountId: 'fixed' },
      target: {
        kind: 'account',
        displayName: 'Account fixed',
      },
    });
  });
});
