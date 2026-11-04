import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { waitForRequesterMachineNaturalBoundary } from './naturalBoundary';

const requester = { serverId: 'saved-home-profile', accountId: 'member-a', machineId: 'machine', installationId: 'installation' };

function fixture() {
    const operations = createActionOperationStore();
    const inventory = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }] });
    let initialReads = 0;
    const create = (id: string, accountId = requester.accountId, attributed = true) => operations.create({
        operationId: id, actionId: 'projects.compute.exec', title: 'Work',
        scope: { accountId, machineId: requester.machineId }, cancellation: 'supported', inputIdentity: id,
        ...(attributed ? { requesterWorkAttributionV1: { ...requester, accountId } } : {}),
    });
    const wait = (signal = new AbortController().signal) => waitForRequesterMachineNaturalBoundary({ requester, signal,
        isCurrentInstallation: () => true, inventory: { subscribeFacts: inventory.subscribeFacts,
            read: () => { initialReads++; return inventory.read(); } } });
    return { operations, inventory, create, wait, reads: () => initialReads };
}

describe('requester retirement natural-boundary composition', () => {
    it('retains native authority for a hosted idle Session until actual exit removes it, while settled Action receipts do not block', async () => {
        let tracked = [{ pid: 42, startedBy: 'daemon' as const, happySessionId: 'hosted-session', requesterWorkAttributionV1: requester }];
        let sessionReads = 0;
        const sessions = createSessionLiveWorkProducer({ readSessions: () => tracked, readActivity: async () => {
            sessionReads++;
            return { session: 'settled', input: 'settled', agents: 'settled', attention: 'settled' };
        } });
        const operations = createActionOperationStore();
        operations.create({ operationId: 'retained-receipt', actionId: 'projects.compute.exec', title: 'Finished work',
            scope: { accountId: requester.accountId, machineId: requester.machineId }, cancellation: 'supported', inputIdentity: '{}',
            requesterWorkAttributionV1: requester });
        operations.succeed('retained-receipt', {});
        const inventory = createManagedActivityInventory({ producers: [sessions,
            { read: operations.readLiveWork, subscribe: operations.subscribe }] });
        const cancel = new AbortController();
        let initialReads = 0, withdrawals = 0;
        const result = waitForRequesterMachineNaturalBoundary({ requester, signal: cancel.signal,
            isCurrentInstallation: () => true, inventory: { subscribeFacts: inventory.subscribeFacts,
                read: () => { initialReads++; return inventory.read(); } } }).then(value => {
                    if (value.kind === 'settled') withdrawals++;
                    return value;
                });
        try {
            await nextTurn();
            expect(withdrawals).toBe(0);
            sessions.notifyChanged('observation'); await nextTurn();
            expect(withdrawals).toBe(0); expect(sessionReads).toBe(2);
            // createOnChildExited removes the canonical tracked occurrence only
            // after its real process/material cleanup, then emits this owner edge.
            tracked = []; sessions.notifyChanged();
            expect(await result).toEqual({ kind: 'settled' });
            expect(withdrawals).toBe(1); expect(initialReads).toBe(1);
            expect(operations.get({ accountId: requester.accountId, machineId: requester.machineId }, 'retained-receipt')?.state).toBe('succeeded');
        } finally { cancel.abort(); await result; inventory.dispose(); }
    });

    it('waits for each exact requester operation to finish naturally while neighbors continue, with one initial read', async () => {
        const { operations, inventory, create, wait, reads } = fixture();
        create('a-first'); create('a-second');
        for (let index = 0; index < 100; index++) create(`neighbor-${index}`, 'member-b');
        let settled = false;
        const result = wait().then(value => { settled = true; return value; });
        try {
            await nextTurn(); expect(settled).toBe(false);
            operations.succeed('a-first', {});
            await nextTurn(); expect(settled).toBe(false);
            operations.succeed('a-second', {});
            expect(await result).toEqual({ kind: 'settled' });
            expect(reads()).toBe(1);
            expect(operations.get({ accountId: 'member-b', machineId: 'machine' }, 'neighbor-0')?.state).toBe('accepted');
        } finally { inventory.dispose(); }
    });

    it('settles incomplete on cancellation without cancelling admitted work', async () => {
        const { operations, inventory, create, wait, reads } = fixture();
        const cancel = new AbortController(); create('admitted');
        const result = wait(cancel.signal);
        try {
            await nextTurn(); cancel.abort();
            expect(await result).toEqual({ kind: 'incomplete' });
            expect(operations.get({ accountId: 'member-a', machineId: 'machine' }, 'admitted')?.state).toBe('accepted');
            operations.succeed('admitted', {}); await nextTurn(); expect(reads()).toBe(1);
        } finally { inventory.dispose(); }
    });

    it('keeps missing attribution incomplete instead of certifying an empty requester', async () => {
        const { inventory, create, wait } = fixture(); create('unknown', 'member-a', false);
        try { expect(await wait()).toEqual({ kind: 'incomplete' }); }
        finally { inventory.dispose(); }
    });
});
