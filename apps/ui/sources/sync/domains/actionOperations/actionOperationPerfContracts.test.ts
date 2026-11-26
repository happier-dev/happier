import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ActionOperationSnapshotV1Schema,
    type ActionOperationGetV1Response,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc/errors';
import { createDeferred, flushHookEffects } from '@/dev/testkit';

const machineRpcMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcMock,
}));

import { createActionOperationAcknowledgementPersistence } from './actionOperationAcknowledgements';
import { createActionOperationSelectors } from './actionOperationSelectors';
import { actionOperationStore, createActionOperationStore } from './actionOperationStore';
import { consumeActionOperationSnapshotPush } from './consumeActionOperationSnapshotPush';
import { observeActionOperation } from './observeActionOperationByRequestId';
import { getPersistenceStorage } from '../state/persistenceStorage';
import { serverAccountScopedStorageKey } from '../scope/serverAccountScope';
import { actionOperationAddressKey } from './qualifiedActionOperation';

const baseSnapshot: ActionOperationSnapshotV1 = {
    version: 1,
    operationId: 'operation-1',
    revision: 2,
    actionId: 'session.spawn_new',
    state: 'running',
    scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
    title: 'Create session',
    requestId: 'request-1',
    createdAt: 100,
    startedAt: 110,
    progress: { kind: 'phase', phase: 'creating', label: 'Creating session' },
    cancellation: 'supported',
};

describe('actionOperations performance contracts (COORD-FIX-ACTION-OPS-PERF-1126)', () => {
    beforeEach(() => {
        machineRpcMock.mockReset();
        actionOperationStore.reset();
    });

    afterEach(() => {
        actionOperationStore.reset();
        vi.restoreAllMocks();
    });

    it('makes 0 daemon RPCs and invokes onSnapshot for snapshotComplete machines.reboot and succeeded machines.setup.apply pushes', async () => {
        const store = createActionOperationStore();
        const readSnapshot = vi.fn(async (): Promise<ActionOperationGetV1Response> => {
            throw new Error('should not call getActionOperation');
        });
        const onSnapshot = vi.fn();

        const reboot = ActionOperationSnapshotV1Schema.parse({
            ...baseSnapshot,
            operationId: 'reboot-1',
            actionId: 'machines.reboot',
            domainRef: {
                kind: 'machineReboot',
                serverId: 'home-1',
                machineId: 'machine-1',
                installationId: 'installation-1',
                task: { id: 'task-1', taskKind: 'machine.reboot.v1' },
                basis: {
                    bootedAt: 1000,
                    expectedRunningServiceIds: ['worker'],
                    expectedRunningServicesKnown: true,
                    dispatchStarted: true,
                },
            },
        });
        const setupSucceeded = ActionOperationSnapshotV1Schema.parse({
            ...baseSnapshot,
            operationId: 'setup-1',
            actionId: 'machines.setup.apply',
            state: 'succeeded',
            settledAt: 150,
            domainRef: {
                kind: 'machineSetup',
                serverId: 'home-1',
                machineId: 'machine-1',
                steps: [],
            },
        });

        await consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: reboot } },
            accountEncryptionMode: 'plain',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            store,
            readSnapshot,
            onSnapshot,
        });
        await consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: setupSucceeded } },
            accountEncryptionMode: 'plain',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            store,
            readSnapshot,
            onSnapshot,
        });

        expect(readSnapshot).not.toHaveBeenCalled();
        expect(onSnapshot).toHaveBeenCalledTimes(2);
        expect(onSnapshot).toHaveBeenNthCalledWith(1, { serverId: 'home-1', snapshot: reboot, snapshotComplete: true });
        expect(onSnapshot).toHaveBeenNthCalledWith(2, { serverId: 'home-1', snapshot: setupSucceeded, snapshotComplete: true });
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['available']);
    });

    it('coalesces 5 rapid revisions per operation address without concurrent overlapping RPCs while observing the final revision', async () => {
        const store = createActionOperationStore();
        let inFlight = 0;
        let maxInFlight = 0;
        const pending: Array<(response: ActionOperationGetV1Response) => void> = [];
        const readSnapshot = vi.fn(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                return await new Promise<ActionOperationGetV1Response>(resolve => pending.push(resolve));
            } finally {
                inFlight -= 1;
            }
        });
        const push = (pushed: ActionOperationSnapshotV1) => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: pushed } },
            accountEncryptionMode: 'plain',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            store,
            readSnapshot,
        });

        const rev2: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 2, state: 'running' };
        const rev3: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 3, state: 'running' };
        const rev4: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 4, state: 'running' };
        const rev5: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 5, state: 'running' };
        const rev6: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 6, state: 'succeeded', settledAt: 200, result: { sessionId: 'created' } };

        const promises = [push(rev2), push(rev3), push(rev4), push(rev5), push(rev6)];
        await flushHookEffects();
        expect(readSnapshot).toHaveBeenCalledTimes(1);
        expect(maxInFlight).toBe(1);

        pending[0]!({ kind: 'found', operation: rev2 });
        await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
        expect(maxInFlight).toBe(1);

        pending[1]!({ kind: 'found', operation: rev6 });
        await Promise.all(promises);
        expect(readSnapshot).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([
            { serverId: 'home-1', snapshot: rev6, snapshotComplete: true },
        ]);
    });

    it('skips the follow-up RPC when the first coalesced read already returns the latest revision', async () => {
        const store = createActionOperationStore();
        const pending: Array<(response: ActionOperationGetV1Response) => void> = [];
        const readSnapshot = vi.fn(() => new Promise<ActionOperationGetV1Response>(resolve => pending.push(resolve)));
        const push = (pushed: ActionOperationSnapshotV1) => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: pushed } },
            accountEncryptionMode: 'plain',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            store,
            readSnapshot,
        });

        const rev2: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 2, state: 'running' };
        const rev6: ActionOperationSnapshotV1 = { ...baseSnapshot, revision: 6, state: 'succeeded', settledAt: 200, result: { sessionId: 'created' } };

        const promises = [push(rev2), push({ ...baseSnapshot, revision: 3 }), push(rev6)];
        await flushHookEffects();
        expect(readSnapshot).toHaveBeenCalledTimes(1);

        pending[0]!({ kind: 'found', operation: rev6 });
        await Promise.all(promises);
        expect(readSnapshot).toHaveBeenCalledTimes(1);
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([
            { serverId: 'home-1', snapshot: rev6, snapshotComplete: true },
        ]);
    });

    it('fires 1 RPC (not 2) when observeActionOperation starts with a retained non-terminal snapshot and ignores intermediate progress pushes while waitForTerminal is active', async () => {
        const running: ActionOperationSnapshotV1 = { ...baseSnapshot, operationId: 'retained-op', revision: 1, state: 'running' };
        actionOperationStore.mergeSnapshots({ serverId: 'home-1', snapshots: [running] });

        const firstRpc = createDeferred<unknown>();
        machineRpcMock.mockImplementation(() => firstRpc.promise);

        const controller = new AbortController();
        const updates: number[] = [];
        const observing = observeActionOperation({
            serverId: 'home-1',
            accountId: 'account-1',
            machineId: 'machine-1',
            operationId: 'retained-op',
            actionId: running.actionId,
            signal: controller.signal,
            onUpdate: op => updates.push(op.revision),
        });

        await vi.waitFor(() => expect(machineRpcMock).toHaveBeenCalledTimes(1));
        // Intermediate progress pushes for the same operationId while waitForTerminal is active.
        actionOperationStore.mergeSnapshots({ serverId: 'home-1', snapshots: [{ ...running, revision: 2 }] });
        actionOperationStore.mergeSnapshots({ serverId: 'home-1', snapshots: [{ ...running, revision: 3 }] });

        // First RPC fails with recoverable transport error: must NOT immediately trigger a spurious 2nd RPC.
        firstRpc.resolve({ error: 'Transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
        await flushHookEffects();
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(updates).toEqual([1, 2, 3]);

        // Terminal complete push settles observation cleanly without another RPC.
        const terminal: ActionOperationSnapshotV1 = { ...running, revision: 4, state: 'succeeded', settledAt: 250 };
        actionOperationStore.mergeSnapshots({ serverId: 'home-1', snapshots: [terminal], snapshotComplete: true });
        await expect(observing).resolves.toEqual(terminal);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        controller.abort();
    });

    it('memoizes selectInbox in O(1) on unchanged snapshots, avoids dead selectAll work in project/managed selectors, and clears scoped list caches on reset', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const failed: ActionOperationSnapshotV1 = { ...baseSnapshot, operationId: 'failed-1', state: 'failed', settledAt: 150 };
        const scriptOp: ActionOperationSnapshotV1 = {
            ...baseSnapshot,
            operationId: 'script-1',
            actionId: 'projects.script.run',
            domainRef: {
                kind: 'projectCommand',
                purpose: 'script',
                serverId: 'home-1',
                machineId: 'machine-1',
                workspaceRefId: 'ws-1',
                cwd: '/repo',
                sourceWorkspace: { serverId: 'home-1', machineId: 'machine-1', workspaceId: 'ws-1', rootPath: '/repo' },
                script: { name: 'build', source: { kind: 'command', command: 'build' } },
            },
        };
        const openOp: ActionOperationSnapshotV1 = {
            ...baseSnapshot,
            operationId: 'open-1',
            actionId: 'projects.open',
            domainRef: { kind: 'projectOpen', sourceId: 'source-1' },
        };
        const managedOp: ActionOperationSnapshotV1 = {
            ...baseSnapshot,
            operationId: 'managed-1',
            actionId: 'machines.managed.acquire',
            domainRef: { kind: 'managedMachine', id: 'managed-1', providerId: 'provider-1', machineId: 'machine-1' },
        };
        store.mergeSnapshots({ serverId: 'home-1', snapshots: [failed, scriptOp, openOp, managedOp] });

        // 1. selectProjectOperation / selectForProjectOpen / selectForManagedMachine must NOT call dead selectAll(state).
        const freshSelectors = createActionOperationSelectors();
        const snapshot = store.getSnapshot();
        const entriesSpy = vi.spyOn(snapshot.operationsByKey, 'entries');
        expect(freshSelectors.selectForProjectScript(snapshot, {
            accountId: 'account-1',
            workspace: { serverId: 'home-1', machineId: 'machine-1', workspaceId: 'ws-1', rootPath: '/repo' },
            selection: { kind: 'named', name: 'build' },
        })?.snapshot.operationId).toBe('script-1');
        expect(freshSelectors.selectForProjectOpen(snapshot, {
            serverId: 'home-1',
            accountId: 'account-1',
            machineId: 'machine-1',
            sourceId: 'source-1',
        })?.snapshot.operationId).toBe('open-1');
        expect(freshSelectors.selectForManagedMachine(snapshot, {
            serverId: 'home-1',
            accountId: 'account-1',
            machineId: 'machine-1',
            managedId: 'managed-1',
        })?.snapshot.operationId).toBe('managed-1');
        expect(entriesSpy).not.toHaveBeenCalled();

        // 2. selectInbox short-circuits in O(1) on unchanged snapshot.
        const firstInbox = selectors.selectInbox(snapshot);
        expect(firstInbox).toHaveLength(1);
        const seenGetSpy = vi.spyOn(snapshot.seenAtByOperationKey, 'get');
        for (let i = 0; i < 5; i++) {
            expect(selectors.selectInbox(snapshot)).toBe(firstInbox);
        }
        expect(seenGetSpy).not.toHaveBeenCalled();

        // 3. selectForSession preserves cross-snapshot stability and clears on reset.
        const sessionBefore = selectors.selectForSession(snapshot, { serverId: 'home-1', sessionId: 'session-1' });
        store.mergeSnapshots({
            serverId: 'home-1',
            snapshots: [{ ...baseSnapshot, operationId: 'other-session-op', scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-2' } }],
        });
        expect(selectors.selectForSession(store.getSnapshot(), { serverId: 'home-1', sessionId: 'session-1' })).toBe(sessionBefore);
        store.reset();
        expect(selectors.selectForSession(store.getSnapshot(), { serverId: 'home-1', sessionId: 'session-1' })).toEqual([]);
    });

    it('skips untouched scopes when saving action operation acknowledgements', () => {
        const storage = getPersistenceStorage();
        const scopeA = { serverId: 'home-a', accountId: 'account-a' };
        const scopeB = { serverId: 'home-b', accountId: 'account-b' };
        const keyA = serverAccountScopedStorageKey('action-operation-acknowledgements-v1', scopeA);
        const keyB = serverAccountScopedStorageKey('action-operation-acknowledgements-v1', scopeB);
        storage.set(keyA, JSON.stringify({ version: 1, entries: [] }));
        storage.set(keyB, JSON.stringify({
            version: 1,
            entries: [{ operationId: 'op-b', machineId: 'machine-b', seenAt: 500, seenRevision: 2 }],
        }));

        const persistence = createActionOperationAcknowledgementPersistence();
        persistence.hydrate(scopeA);
        persistence.hydrate(scopeB);

        const getStringSpy = vi.spyOn(storage, 'getString');
        const setSpy = vi.spyOn(storage, 'set');

        const opAKey = actionOperationAddressKey({ serverId: 'home-a', operationId: 'op-a' });
        const opBKey = actionOperationAddressKey({ serverId: 'home-b', operationId: 'op-b' });
        persistence.save({
            operationsByKey: new Map([
                [opAKey, {
                    serverId: 'home-a',
                    snapshot: { ...baseSnapshot, operationId: 'op-a', state: 'failed', settledAt: 200, scope: { accountId: 'account-a', machineId: 'machine-a' } },
                }],
            ]),
            seenAtByOperationKey: new Map([
                [opAKey, { seenAt: 300, revision: 2 }],
                [opBKey, { seenAt: 500, revision: 2 }],
            ]),
            dismissedRecentOperationKeys: new Set(),
        });

        expect(getStringSpy.mock.calls.map(call => call[0])).not.toContain(keyB);
        expect(setSpy.mock.calls.map(call => call[0])).toEqual([keyA]);
    });
});
