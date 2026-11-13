import { describe, expect, it, onTestFinished } from 'vitest';
import fastify from 'fastify';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission, type ProjectWorkerReservationOutcome } from '@/workspaces/execution/projectWorkerAdmission';
import type { TrackedSession } from '@/daemon/types';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineWorkSummaryRpcHandlers } from './rpcHandlers.machineWorkSummary';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from './machineRpcAuthorization';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const custodian = { accountId: 'alice', displayName: 'Alice' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

describe('current Machine work summary ingress', () => {
    it('answers its custodian whatever id the caller\'s device gives this Home', async () => {
        // A Home id in the input is the caller's own server-profile id (a browser's differs from the
        // daemon's). The server-admitted machine admission, not that local id, says which machine is asked.
        const app = fastify();
        onTestFinished(() => app.close());
        // The Home HTTP response is the network boundary; use the same real
        // access adapter as ApiMachineClient rather than a ready-access stub.
        let readiness: 'ready' | 'key_pending' = 'ready';
        app.get('/v1/machines/machine/access', async request => {
            expect(request.headers.authorization).toBe('Bearer custodian-token');
            return { machineId: target.machineId, custodian,
                access: { custodian, role: 'manage', resourceMode: 'plain', accessState: readiness },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [], currentRequesterDisplayIdentities: [] };
        });
        await app.ready();
        onTestFinished(installAxiosFastifyAdapter({ app, origin: 'http://work-summary.test' }));
        const access = createAccountServerActionDeps({ token: 'custodian-token', serverId: target.serverId,
            serverHttpBaseUrl: 'http://work-summary.test' });
        const operations = createActionOperationStore();
        const activity = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }] });
        let admissions = 0;
        const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, encryptionMode: 'plain', logger: () => {},
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
                machineId: target.machineId, resolveCustodianAccountId: async () => custodian.accountId,
                resolveInstallationId: () => target.installationId,
                // Current Home admission is the network boundary; retain the
                // real parser, installed target checks and summary owner.
                verifyMachineAdmission: async () => { admissions++; return true; },
            }, source) });
        registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager: rpc,
            target, custodianAccountId: custodian.accountId, activity,
            readAccess: signal => access.machineAccessAction!({ actionId: 'machines.access.grants.list',
                input: { serverId: target.serverId, machineId: target.machineId },
                context: { surface: 'cli', serverId: target.serverId }, signal }),
        });
        const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: target.machineId,
            installationId: target.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
        const request = { method: `${target.machineId}:machines.work.summary.get`,
            params: { serverId: 'browser-profile-for-home', machineId: target.machineId }, machineAdmission };
        try {
            const call = () => rpc.handleRequest(request, undefined, 'authenticated_home_socket');
            expect(await call()).toEqual({ kind: 'current', requesters: [], finiteLoad: { kind: 'unknown' } });
            // Authenticated Home transport has already admitted this request.
            expect(admissions).toBe(0);
            readiness = 'key_pending';
            expect(await call()).toEqual({ kind: 'unavailable' });
            readiness = 'ready';
            expect(await call()).toEqual({ kind: 'current', requesters: [], finiteLoad: { kind: 'unknown' } });
            expect(await rpc.handleRequest({ ...request,
                machineAdmission: { ...machineAdmission, actorAccountId: 'viewer', role: 'use' },
            }, undefined, 'authenticated_home_socket')).toEqual({ kind: 'refused', code: 'access_denied' });
            expect(await rpc.handleRequest({ ...request, params: { ...request.params, machineId: 'another-machine' } },
                undefined, 'authenticated_home_socket')).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        } finally {
            activity.dispose();
        }
    });

    it('preserves independent finite load when the managed requester inventory is unavailable', async () => {
        // The real startup group has no installed producer yet; it reports
        // unknown coverage rather than manufacturing an empty requester list.
        const unavailableOwner = createLiveWorkProducerGroup(() => null);
        const activity = createManagedActivityInventory({ producers: [unavailableOwner] });
        const admission = createProjectWorkerAdmission({ machineId: target.machineId,
            admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', source: 'stored', metadataVersion: 1, policy: { accepting: true, runAtMost: 1 } }),
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
        const handlers = new Map<string, RpcHandler>();
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
            expect(await call()).toEqual({ kind: 'unavailable',
                finiteLoad: { kind: 'known', running: 1, queued: 0, accepting: true, runAtMost: 1 },
            });
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

    it('projects from custodian-local activity when managed requester coverage is unavailable', async () => {
        const managedUnavailable = createLiveWorkProducerGroup(() => null);
        const managedActivity = createManagedActivityInventory({ producers: [managedUnavailable] });
        const localOperations = createActionOperationStore();
        localOperations.create({ operationId: 'local-operation', actionId: 'machines.managed.power.set', title: 'Local managed task',
            scope: { accountId: 'bob', machineId: target.machineId }, cancellation: 'supported', inputIdentity: '{}',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } });
        const localActivity = createManagedActivityInventory({ producers: [{ read: localOperations.readLiveWork, subscribe: localOperations.subscribe }] });
        const handlers = new Map<string, RpcHandler>();
        registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager: {
            registerHandler(method, handler) { handlers.set(method, handler); },
        }, target, custodianAccountId: custodian.accountId, activity: managedActivity, summaryActivity: localActivity,
        readAccess: async () => ({ machineId: target.machineId, custodian,
            access: { custodian, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            currentRequesterDisplayIdentities: [{ accountId: 'bob', displayName: 'Bob' }] }) });
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: target.machineId,
                installationId: target.installationId, role: 'manage', encryptionMode: 'e2ee' },
            verifyMachineAdmissionCurrent: async () => true };
        try {
            expect((await managedActivity.read()).coverage).toBe('unknown');
            expect(await handlers.get('machines.work.summary.get')!({ serverId: target.serverId, machineId: target.machineId }, context))
                .toEqual({ kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 }],
                    finiteLoad: { kind: 'unknown' } });
        } finally {
            managedActivity.dispose();
            managedUnavailable.dispose();
            localActivity.dispose();
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
            readPolicy: async () => policyAvailable ? { status: 'ready', source: 'stored', metadataVersion: 1,
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
        const handlers = new Map<string, RpcHandler>();
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
            expect(await call()).toMatchObject({ kind: 'current', finiteLoad: { kind: 'known', running: 1, queued: 1 } });
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

    it('admits one summary for custodian/Manage and refuses the next request after withdrawal', async () => {
        const operations = createActionOperationStore();
        let current = true;
        let trackedSessions: TrackedSession[] = [];
        const sessions = createSessionLiveWorkProducer({ readSessions: () => trackedSessions,
            // The live Session RPC boundary retires admission while the real inventory awaits it.
            readActivity: async () => { current = false; return {
                session: 'settled', input: 'settled', agents: 'settled', attention: 'settled',
            }; },
        });
        const activity = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }, sessions] });
        operations.create({ operationId: 'private-operation', actionId: 'projects.script.run', title: 'Private command',
            scope: { accountId: 'bob', machineId: target.machineId }, cancellation: 'supported', inputIdentity: '{}',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } });
        const handlers = new Map<string, RpcHandler>();
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
        let admissions = 0;
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: target.machineId,
                installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => { admissions++; return current; } };
        const call = (ctx: RpcHandlerContext | undefined = context, input: unknown = { serverId: target.serverId, machineId: target.machineId }) =>
            handlers.get('machines.work.summary.get')!(input, ctx);
        const expected = { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 }],
            finiteLoad: { kind: 'unknown' } };
        expect(await call()).toEqual(expected);
        expect(admissions).toBe(1);
        expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'manager' } })).toEqual(expected);
        expect(await call({ ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'bob', role: 'use' } }))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await call({ signal: context.signal })).toEqual({ kind: 'refused', code: 'access_denied' });
        // Another machine is refused; the caller's own id for this Home is not compared (see the test above).
        expect(await call(context, { serverId: target.serverId, machineId: 'other-machine' }))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        retireDuringRead = true;
        expect(await call()).toEqual(expected);
        expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
        current = true;
        retireDuringRead = false;
        trackedSessions = [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'private-session',
            requesterWorkAttributionV1: { ...target, accountId: 'bob' } }];
        expect(await call()).toMatchObject({ kind: 'current', requesters: [{ accountId: 'bob', sessions: 1, tasks: 1 }] });
        expect(await call()).toEqual({ kind: 'refused', code: 'access_denied' });
        current = true;
        trackedSessions = [];
        operations.cancel('private-operation');
        expect(await call()).toEqual({ kind: 'current', requesters: [], finiteLoad: { kind: 'unknown' } });
        activity.dispose();
    });
});
