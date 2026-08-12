import { describe, expect, it, vi } from 'vitest';

import type {
  QualifiedConnectedAccountPurposeBindingsV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
  composeConnectedAccountSessionPurposeBindingSnapshot,
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
  type ConnectedAccountPurposeResolvedTarget,
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
  resolveTarget?: (
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
  ) => Promise<ConnectedAccountPurposeResolvedTarget | null>;
}> = {}) {
  const store = input.store ?? memoryStore();
  const materializeAccount = vi.fn(async ({ account, request }) => {
    if (request.kind !== 'environment') throw new Error('test only supports environment');
    return {
      kind: 'environment' as const,
      env: Object.fromEntries(request.keys.map((key: string) => [key, `token:${account.accountId}`])),
    };
  });
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
    materializeAccount,
  });
  return { owner, store, materializeAccount };
}

const authorized = {
  purpose,
  serviceRefs: [service],
  assertGenerationCurrent: () => undefined,
} as const;

describe('ConnectedAccountPurposeBindingOwner', () => {
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

  it('revalidates stale-read cleanup so it cannot erase a later same-target reselection', async () => {
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

  it('fails materialization closed when unbound and forwards binding/projection invalidations', async () => {
    const store = memoryStore();
    const { owner } = createOwner({ store });
    const listener = vi.fn();
    const subscription = owner.watch({ ...authorized, listener });

    await expect(owner.materialize({
      ...authorized,
      request: { kind: 'environment', keys: ['TOKEN'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });

    store.invalidate();
    expect(listener).toHaveBeenCalledOnce();
    subscription.dispose();
    store.invalidate();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('compare-and-deletes a persisted binding when its account is removed', async () => {
    let available = true;
    const { owner, store } = createOwner({ resolveAvailable: () => available });
    const signal = new AbortController().signal;
    await owner.requestSelection({ ...authorized, reason: 'Choose account', signal });
    expect(store.current().bindings).toHaveLength(1);

    available = false;
    await expect(owner.getBinding({ ...authorized, signal })).resolves.toBeNull();
    expect(store.current().bindings).toEqual([]);
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

  it('preserves continuously compatible purposes while deleting an incompatible service scope in the same owner update', async () => {
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

  it('returns unbound after a durable service-scope shrink and compare-deletes only the exact stale target', async () => {
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
    expect(store.current().bindings).toEqual([]);

    await initial.owner.requestSelection({
      ...authorized,
      reason: 'Choose the original account again',
      signal,
    });
    let replaceBeforeDelete = true;
    const interleavingStore: ReturnType<typeof memoryStore> = {
      ...store,
      async update(mutate, updateSignal) {
        if (replaceBeforeDelete) {
          replaceBeforeDelete = false;
          await store.update((current) => ({
            v: 1,
            bindings: current.bindings.map((binding) => ({
              ...binding,
              target: {
                kind: 'account' as const,
                account: {
                  service: otherService,
                  accountId: 'replacement',
                },
              },
            })),
          }), updateSignal);
        }
        return await store.update(mutate, updateSignal);
      },
    };
    const replacement = createOwner({ store: interleavingStore });

    await expect(replacement.owner.getBinding({
      purpose,
      serviceRefs: [otherService],
      signal,
    })).resolves.toBeNull();
    expect(store.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: {
          service: otherService,
          accountId: 'replacement',
        },
      },
    }]);
    await expect(replacement.owner.getBinding({
      purpose,
      serviceRefs: [otherService],
      signal,
    })).resolves.toEqual({
      purpose: purpose.purpose,
      service: otherService,
      target: {
        kind: 'account',
        displayName: 'Account replacement',
      },
    });
  });
});
