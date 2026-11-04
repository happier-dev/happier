import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { waitForRequesterMachineNaturalBoundary } from './naturalBoundary';
import { memberIdentityRetirementInput, supersedeMemberIdentityRetirement } from './supersedeRetirement';

describe('host admission ordering supersedes an existing retirement operation', () => {
  it('cancels only the exact waiting retirement, retains admitted work, and permits a later independent loss', async () => {
    const target = { homeServerIdentityId: 'canonical-home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    const ownerScope = { accountId: target.custodianAccountId, machineId: target.machineId };
    // Equal wall-clock times cannot supply host admission order. The existing
    // store's local invocation acceptance is the deciding lifecycle fact.
    const store = createActionOperationStore({ now: () => 1 }), payload = store;
    const spec = getActionSpec('machines.agentIsolation.set');
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `retirement-${++sequence}`,
      resolveAction: actionId => actionId === spec.id ? { actionId: spec.id, title: spec.title, operation: spec.operation } : null });
    const inventory = createManagedActivityInventory({ producers: [{ read: store.readLiveWork, subscribe: store.subscribe }] });
    const requester = (accountId: string) => ({ serverId: 'saved-home-profile', accountId, machineId: target.machineId, installationId: target.installationId });
    for (const accountId of ['a', 'b']) payload.create({ operationId: `payload-${accountId}`, actionId: 'projects.compute.exec',
      title: 'Admitted work', scope: { accountId, machineId: target.machineId }, cancellation: 'supported', inputIdentity: accountId,
      requesterWorkAttributionV1: requester(accountId) });
    const withdrawals: string[] = [];
    const retire = (accountId: string, requestId: string, retiredTarget = target) => runner.observe({
      actionId: spec.id, scope: ownerScope, input: memberIdentityRetirementInput(retiredTarget, accountId),
      requestId, cancellation: 'supported', requesterWorkAttributionV1: requester(target.custodianAccountId),
      execute: async context => {
        const boundary = await waitForRequesterMachineNaturalBoundary({ requester: requester(accountId), inventory,
          signal: context.signal, isCurrentInstallation: () => true, excludeOperationId: context.operationAcceptance?.operationId });
        if (boundary.kind !== 'settled' || context.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        withdrawals.push(`${retiredTarget.installationId}/${accountId}`); return { ok: true, result: { kind: 'settled' } };
      },
    });
    const oldA = retire('a', 'loss-a-first'), oldB = retire('b', 'loss-b-first');
    // Another installation's retained operation is a materially distinct owner.
    const neighbor = retire('a', 'loss-a-other-installation', { ...target, installationId: 'other-installation' });
    try {
      await nextTurn();
      expect(withdrawals).toEqual([]);
      expect(await supersedeMemberIdentityRetirement({ target, accountId: 'a', operations: { store, runner } })).toEqual({ kind: 'settled' });
      expect(store.list({ ...ownerScope, states: ['running'] }).items.map(item => item.requestId).sort())
        .toEqual(['loss-a-first', 'loss-a-other-installation', 'loss-b-first']);
      // The old payload was admitted before loss. Reaching native preparation
      // late cannot turn that old admission into a restored grant.
      const delayed = { target, accountId: 'a', operations: { store, runner }, admittedOperationId: 'payload-a', requesterServerId: 'saved-home-profile' };
      expect(await supersedeMemberIdentityRetirement(delayed)).toEqual({ kind: 'settled' });
      expect(store.list({ ...ownerScope, states: ['running'] }).items.map(item => item.requestId).sort())
        .toEqual(['loss-a-first', 'loss-a-other-installation', 'loss-b-first']);
      payload.create({ operationId: 'renewed-a', actionId: 'projects.compute.exec', title: 'Newly admitted work',
        scope: { accountId: 'a', machineId: target.machineId }, cancellation: 'supported', inputIdentity: 'renewed-a',
        requesterWorkAttributionV1: requester('a') });
      const renewed = { target, accountId: 'a', operations: { store, runner }, admittedOperationId: 'renewed-a', requesterServerId: 'saved-home-profile' };
      expect(await supersedeMemberIdentityRetirement(renewed)).toEqual({ kind: 'settled' });
      expect(await oldA).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(payload.get({ accountId: 'a', machineId: target.machineId }, 'payload-a')?.state).toBe('accepted');
      expect(store.list({ ...ownerScope, states: ['running'] }).items.map(item => item.requestId).sort())
        .toEqual(['loss-a-other-installation', 'loss-b-first']);
      payload.succeed('payload-a', {});
      payload.succeed('renewed-a', {});
      // A distinct later loss must execute; a stable reused request key would
      // replay the cancelled first loss and leave launch authority behind.
      expect(await retire('a', 'loss-a-second')).toMatchObject({ ok: true });
      expect(withdrawals.filter(identity => identity === 'installation/a')).toHaveLength(1);
    } finally {
      for (const operation of store.list({ ...ownerScope, states: ['accepted', 'running'] }).items) runner.cancel(ownerScope, operation.operationId);
      await Promise.allSettled([oldA, oldB, neighbor]); inventory.dispose();
    }
  });
});
