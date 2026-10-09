import { describe, expect, it } from 'vitest';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission, type ProjectWorkerReservationOutcome } from '@/workspaces/execution/projectWorkerAdmission';
import type { TrackedSession } from '@/daemon/types';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineWorkSummaryRpcHandlers } from './rpcHandlers.machineWorkSummary';

const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const custodian = { accountId: 'alice', displayName: 'Alice' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

describe('current Machine work summary ingress', () => {
    it('preserves independent finite load when the managed requester inventory is unavailable', async () => {
        // The real startup group has no installed producer yet; it reports
        // unknown coverage rather than manufacturing an empty requester list.
        const unavailableOwner = createLiveWorkProducerGroup(() => null);
        const activity = createManagedActivityInventory({ producers: [unavailableOwner] });
        const admission = createProjectWorkerAdmission({ machineId: target.machineId,
            admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', metadataVersion: 1, policy: { accepting: true, runAtMost: 1 } }),
        });
        const settlement = deferred<ProjectWorkerReservationOutcome>();
        const accepted = deferred<void>();
        const controller = new AbortController();
        const executing = admission.execute({ operationId: 'private-held-operation', workspaceRefId: 'private-checkout',
            requesterAccountId: 'bob', signal: controller.signal, accept: () => accepted.resolve(),
            run: async reservation => { reservation.phase('setup'); return await settlement.promise; },
        });
        let current = true;
        let retireDuringFiniteRead = false;
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const rpcHandlerManager: RpcHandlerRegistrar = {
            registerHandler(method, handler) { handlers.set(method, handler); },
        };
        registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager, target, custodianAccountId: custodian.accountId, activity,
            readAccess: async () => ({ machineId: target.machineId, custodian,
                access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [], currentRequesterDisplayIdentities: [] }),
            readFiniteLoad: async () => {
                const { load } = await admission.observeFiniteEligibility();
                if (retireDuringFiniteRead) current = false;
                return load;
            },
        });
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'manager', custodianAccountId: 'alice', machineId: target.machineId,
                installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => current };
        const call = (ctx = context) => handlers.get('machines.work.summary.get')!({ serverId: target.serverId, machineId: target.machineId }, ctx);
        try {
            await accepted.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(admission.dependencies()).toMatchObject([{ operationId: 'private-held-operation', state: 'setup' }]);
            expect((await activity.read()).coverage).toBe('unknown');
            expect(await call()).toEqual({ kind: 'unavailable',
                finiteLoad: { kind: 'known', running: 1, queued: 0, accepting: true, runAtMost: 1 },
            });
            retireDuringFiniteRead = true;
            expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
            current = true;
            retireDuringFiniteRead = false;
            expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'bob', role: 'use' } }))
                .toEqual({ kind: 'refused', code: 'access_denied' });
        } finally {
            controller.abort();
            settlement.resolve({ kind: 'no_launch', result: { ok: true, result: { kind: 'notRequired' } } });
            await executing;
            activity.dispose();
            unavailableOwner.dispose();
        }
    });

    it('reads workspace-free finite load from the same admission without pumping or inferring broad task counts', async () => {
        const operations = createActionOperationStore();
        const activity = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }] });
        let runAtMost: number | null = 1;
        let policyAvailable = true;
        let current = true;
        let retireDuringFiniteRead = false;
        const admission = createProjectWorkerAdmission({ machineId: target.machineId,
            admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => policyAvailable ? { status: 'ready', metadataVersion: 1,
                policy: { accepting: true, runAtMost } } : { status: 'unavailable' },
        });
        const controllers = [new AbortController(), new AbortController()];
        const settlement = deferred<ProjectWorkerReservationOutcome>();
        const started: string[] = [];
        const accepted = [deferred<void>(), deferred<void>()];
        const executing = ['held', 'waiting'].map((name, index) => {
            operations.create({ operationId: name, actionId: 'projects.script.run', title: 'Private script',
                scope: { accountId: 'bob', machineId: target.machineId }, cancellation: 'supported', inputIdentity: '{}',
                requesterWorkAttributionV1: { ...target, accountId: 'bob' } });
            return admission.execute({ operationId: name, workspaceRefId: 'private-checkout', requesterAccountId: 'bob',
                signal: controllers[index]!.signal, accept: () => accepted[index]!.resolve(),
                run: async reservation => {
                    started.push(name);
                    reservation.phase('setup');
                    return await settlement.promise;
                },
            });
        });
        // An actual operation in the incumbent inventory, unrelated to this
        // Project FIFO, contributes to broad tasks but not its finite slots.
        operations.create({ operationId: 'managed-task', actionId: 'machines.managed.power.set', title: 'Private managed task',
            scope: { accountId: 'bob', machineId: target.machineId }, cancellation: 'supported', inputIdentity: '{}',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const rpcHandlerManager: RpcHandlerRegistrar = {
            registerHandler(method, handler) { handlers.set(method, handler); },
        };
        const owner = { rpcHandlerManager, target, custodianAccountId: custodian.accountId, activity,
        readAccess: async () => ({ machineId: target.machineId, custodian,
            access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            currentRequesterDisplayIdentities: [{ accountId: 'bob', displayName: 'Bob' }] }),
        readFiniteLoad: async () => {
            const { load } = await admission.observeFiniteEligibility();
            // Only the Home admission/currentness boundary is controlled here.
            if (retireDuringFiniteRead) current = false;
            return load;
        } };
        registerMachineWorkSummaryRpcHandlers(owner);
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: target.machineId,
                installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => current };
        const call = (ctx = context) => handlers.get('machines.work.summary.get')!({ serverId: target.serverId, machineId: target.machineId }, ctx);
        try {
            await Promise.all(accepted.map(entry => entry.promise));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(started).toEqual(['held']);
            // The new ceiling would let the queue launch if this read wrongly
            // used admission.load(), whose public contract includes pumping.
            runAtMost = null;
            expect(await call()).toEqual({ kind: 'current',
                requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 3, terminals: 0 }],
                finiteLoad: { kind: 'known', running: 1, queued: 1, accepting: true, runAtMost: null },
            });
            expect(started).toEqual(['held']);
            expect(admission.dependencies()).toMatchObject([
                { operationId: 'held', state: 'setup' }, { operationId: 'waiting', state: 'queued' },
            ]);
            policyAvailable = false;
            expect(await call()).toMatchObject({ kind: 'current', finiteLoad: { kind: 'unknown' } });
            expect(started).toEqual(['held']);
            policyAvailable = true;
            retireDuringFiniteRead = true;
            expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
            current = true;
            retireDuringFiniteRead = false;
            expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'bob', role: 'use' } }))
                .toEqual({ kind: 'refused', code: 'access_denied' });
        } finally {
            controllers.forEach(controller => controller.abort());
            settlement.resolve({ kind: 'no_launch', result: { ok: true, result: { kind: 'notRequired' } } });
            await Promise.all(executing);
            activity.dispose();
        }
    });

    it('projects the real shared activity owner for custodian/Manage only and rechecks access before disclosure', async () => {
        const operations = createActionOperationStore();
        let current = true;
        let trackedSessions: TrackedSession[] = [];
        const sessions = createSessionLiveWorkProducer({ readSessions: () => trackedSessions,
            // The live Session RPC boundary retires admission while the real inventory awaits it.
            readActivity: async () => { current = false; return { session: 'settled', input: 'settled' }; },
        });
        const activity = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }, sessions] });
        operations.create({ operationId: 'private-operation', actionId: 'projects.script.run', title: 'Private command',
            scope: { accountId: 'bob', machineId: target.machineId }, cancellation: 'supported', inputIdentity: '{}',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        let retireDuringRead = false;
        registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager: {
            registerHandler(method, handler) { handlers.set(method, handler); },
        }, target, custodianAccountId: custodian.accountId, activity,
        readAccess: async () => {
            if (retireDuringRead) current = false;
            return { machineId: target.machineId, custodian,
                access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                currentRequesterDisplayIdentities: [{ accountId: 'bob', displayName: 'Bob' }] };
        } });
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: target.machineId,
                installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => current };
        const call = (ctx: RpcHandlerContext | undefined = context, input: unknown = { serverId: target.serverId, machineId: target.machineId }) =>
            handlers.get('machines.work.summary.get')!(input, ctx);
        const expected = { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 }],
            finiteLoad: { kind: 'unknown' } };
        expect(await call()).toEqual(expected);
        expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'manager' } })).toEqual(expected);
        expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'bob', role: 'use' } }))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await call({ signal: context.signal })).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await call(context, { serverId: 'other-home', machineId: target.machineId }))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        retireDuringRead = true;
        expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
        current = true;
        retireDuringRead = false;
        trackedSessions = [{ pid: 1, startedBy: 'daemon', happySessionId: 'private-session',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } }];
        expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
        current = true;
        trackedSessions = [];
        operations.cancel('private-operation');
        expect(await call()).toEqual({ kind: 'current', requesters: [], finiteLoad: { kind: 'unknown' } });
        activity.dispose();
    });
});
