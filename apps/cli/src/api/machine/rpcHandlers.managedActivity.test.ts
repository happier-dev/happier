import { describe, expect, it } from 'vitest';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createManagedActivityInventory, type LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';
import { registerManagedActivityRpcHandlers } from './rpcHandlers.managedActivity';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import nacl from 'tweetnacl';
import type { ManagedActivityRpcOwner } from './rpcHandlers.managedActivity';
import { ManagedCommittedIdleEvidenceV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from './machineRpcAuthorization';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';

const target = { homeId: 'home', managedId: 'managed', expectedRevision: 3,
    controller: { machineId: 'controller', installationId: 'controller-installation' } };
function setup(commitIdleEvidence?: ManagedActivityRpcOwner['commitIdleEvidence']) {
    let items: readonly LiveWorkItemV1[] = [];
    let targetCurrent = true;
    let accessCurrent = true;
    let admissionReads = 0;
    let duringRead: (() => void) | undefined;
    const drain = createDaemonAdmissionDrain();
    const inventory = createManagedActivityInventory({ producers: [{
        read: () => { duringRead?.(); return { items, coverage: 'complete' }; },
        subscribe: () => () => {},
    }], now: () => 100 });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    registerManagedActivityRpcHandlers({ rpcHandlerManager: {
        registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
            // Raw RPC delivery; the real handler owns request-schema validation.
            handlers.set(method, (raw, context) => handler(raw as TRequest, context));
        },
    }, activity: inventory, admissionDrain: drain, ...(commitIdleEvidence ? { commitIdleEvidence } : {}) });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
            installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
        // The actual Home target admission is the network boundary. Resume
        // releases only its captured drain, even after the target policy changes.
        verifyMachineAdmissionCurrent: async () => { admissionReads++; return accessCurrent && targetCurrent; } };
    return { drain, inventory, context,
        reads: () => admissionReads,
        call: (method: string, input: unknown, ctx: RpcHandlerContext | undefined = context) => {
            const resuming = method === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD
                && input !== null && typeof input === 'object' && 'action' in input && input.action === 'resume';
            const ingress = resuming && ctx === context ? { ...context,
                verifyMachineAdmissionCurrent: async () => { admissionReads++; return accessCurrent; } } : ctx;
            return handlers.get(method)!(input, ingress);
        },
        setItems: (next: typeof items) => { items = next; },
        setAccess: (next: boolean) => { accessCurrent = next; },
        setTarget: (next: boolean) => { targetCurrent = next; },
        duringRead: (callback: () => void) => { duringRead = callback; },
    };
}

describe('managed guest activity bridge', () => {
    it('releases controller-free read probes, busy confirmations and only the exact retained drain through authenticated RPC', async () => {
        const operations = createActionOperationStore();
        const activity = createManagedActivityInventory({ producers: [{ read: operations.readLiveWork, subscribe: operations.subscribe }] });
        const drain = createDaemonAdmissionDrain();
        const guestTarget = { homeId: target.homeId, managedId: target.managedId, expectedRevision: target.expectedRevision };
        const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
            installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'guest', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
                machineId: 'guest', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'guest-installation',
                // Home is the network boundary. RPC admission, material inventory and drain stay real.
                verifyMachineAdmission: async input => input.context.actorAccountId === 'owner',
            }, source) });
        registerManagedActivityRpcHandlers({ rpcHandlerManager: rpc, activity, admissionDrain: drain });
        const call = (method: string, params: unknown) => rpc.handleRequest({ method: `guest:${method}`, params, machineAdmission },
            undefined, 'authenticated_home_socket');
        try {
            expect(await call(MANAGED_ACTIVITY_READ_RPC_METHOD, guestTarget)).toMatchObject({ kind: 'idle' });
            expect(drain.isQuiescing()).toBe(false);
            operations.create({ operationId: 'work', actionId: 'projects.compute.exec', title: 'Work',
                scope: { accountId: 'owner', machineId: 'guest' }, cancellation: 'supported', inputIdentity: '{}' });
            expect(await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...guestTarget, action: 'begin' })).toMatchObject({ kind: 'busy' });
            expect(drain.isQuiescing()).toBe(false);
            operations.succeed('work', {});
            expect(await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...guestTarget, action: 'begin' })).toMatchObject({ kind: 'idle' });
            expect(drain.isQuiescing()).toBe(true);
            await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' });
            expect(drain.isQuiescing()).toBe(true);
            await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...guestTarget, action: 'resume' });
            expect(drain.isQuiescing()).toBe(false);
        } finally { activity.dispose(); }
    });
    it('commits signed guest-clock evidence only for fresh idle under the actual closed drain', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const owner = setup((managedTarget, idle, context) => {
            if (!owner.drain.isQuiescing() || !context.machineAdmission) return null;
            const method = `guest:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`;
            const decision = { ...idle, confirmedAt: 200 };
            return { context: context.machineAdmission, method, managedTarget, decision,
                proof: signMachineInstallationProof({ privateKey: key.secretKey, payload: {
                    version: 1, machineId: 'guest', installationId: 'guest-installation', accountId: 'owner',
                    rpcAdmission: { context: context.machineAdmission, method, managedTarget, managedIdleDecision: decision },
                } }) };
        });
        expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target)).toMatchObject({ kind: 'idle', since: 100,
            evidence: { decision: { kind: 'idle', since: 100, confirmedAt: 200 } } });
        expect(owner.drain.isQuiescing()).toBe(false);
        const result = await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' });
        expect(result).toMatchObject({ kind: 'idle', since: 100, evidence: { decision: { kind: 'idle', since: 100, confirmedAt: 200 } } });
        const evidence = ManagedCommittedIdleEvidenceV1Schema.parse((result as { evidence?: unknown }).evidence);
        expect(verifyMachineInstallationProof({ publicKey: key.publicKey, proof: evidence.proof, payload: {
            version: 1, machineId: 'guest', installationId: 'guest-installation', accountId: 'owner',
            rpcAdmission: { context: evidence.context, method: evidence.method, managedTarget: evidence.managedTarget, managedIdleDecision: evidence.decision },
        } })).toBe(true);
        owner.inventory.dispose();
    });
    it('fresh drain confirmation sees work arriving after idle read and reopens admission', async () => {
        const owner = setup();
        expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target)).toEqual({ kind: 'idle', since: 100 });
        owner.setItems([{ category: 'service', ownerRef: 'private-service', attribution: { kind: 'unknown' }, state: 'active' }]);
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toEqual({ kind: 'busy', reasons: ['service'] });
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.inventory.dispose();
    });

    it('admits the exact activity request once and observes withdrawal at the next request', async () => {
        const owner = setup();
        expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target, { signal: new AbortController().signal }))
            .toMatchObject({ kind: 'refused' });
        owner.setAccess(false);
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toMatchObject({ kind: 'refused' });
        owner.setAccess(true);
        owner.setTarget(false);
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toMatchObject({ kind: 'refused' });
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.setTarget(true);
        owner.duringRead(() => owner.setTarget(false));
        const before = owner.reads();
        const admitted = await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' });
        const after = owner.reads();
        console.info('managed activity admission shape', { admission: after - before });
        expect(admitted).toMatchObject({ kind: 'idle' });
        expect(owner.reads()).toBe(before + 1);
        expect(owner.drain.isQuiescing()).toBe(true);
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toMatchObject({ kind: 'refused' });
        await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' });
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.inventory.dispose();
    });

    it('allows the exact drain custodian to reopen after a policy edit without clearing another cause', async () => {
        const owner = setup();
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toEqual({ kind: 'idle', since: 100 });
        const releaseDrain = owner.drain.beginTemporaryDrain();
        owner.setTarget(false);
        await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' });
        expect(owner.drain.isQuiescing()).toBe(true);
        releaseDrain();
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.inventory.dispose();
    });

    it('does not let a read probe reopen a retained native-effect confirmation', async () => {
        const owner = setup();
        try {
            await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' });
            expect(owner.drain.isQuiescing()).toBe(true);
            expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target)).toMatchObject({ kind: 'idle' });
            expect(owner.drain.isQuiescing()).toBe(true);
            await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' });
            expect(owner.drain.isQuiescing()).toBe(false);
        } finally { owner.inventory.dispose(); }
    });

    it('releases a probe when its transport is aborted during the actual inventory read', async () => {
        const owner = setup();
        const request = new AbortController();
        owner.duringRead(() => request.abort());
        try {
            expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target, { ...owner.context, signal: request.signal }))
                .toMatchObject({ kind: 'refused' });
            expect(owner.drain.isQuiescing()).toBe(false);
        } finally { owner.inventory.dispose(); }
    });
});
