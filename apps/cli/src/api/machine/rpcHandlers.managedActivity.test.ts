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

const target = { homeId: 'home', managedId: 'managed', expectedRevision: 3,
    controller: { machineId: 'controller', installationId: 'controller-installation' } };
function setup(commitIdleEvidence?: ManagedActivityRpcOwner['commitIdleEvidence']) {
    let items: readonly LiveWorkItemV1[] = [];
    let targetCurrent = true;
    let accessCurrent = true;
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
    }, activity: inventory, admissionDrain: drain,
    validateCurrentTarget: async () => targetCurrent, ...(commitIdleEvidence ? { commitIdleEvidence } : {}) });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
            installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => accessCurrent };
    return { drain, inventory, context,
        call: (method: string, input: unknown, ctx: RpcHandlerContext | undefined = context) => handlers.get(method)!(input, ctx),
        setItems: (next: typeof items) => { items = next; },
        setAccess: (next: boolean) => { accessCurrent = next; },
        setTarget: (next: boolean) => { targetCurrent = next; },
        duringRead: (callback: () => void) => { duringRead = callback; },
    };
}

describe('managed guest activity bridge', () => {
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
        expect(await owner.call(MANAGED_ACTIVITY_READ_RPC_METHOD, target)).toEqual({ kind: 'idle', since: 100 });
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

    it('rejects unauthenticated, revoked and changed policy/controller currentness without retaining drain', async () => {
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
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toMatchObject({ kind: 'refused' });
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.inventory.dispose();
    });

    it('allows the exact drain custodian to reopen after a policy edit without clearing another cause', async () => {
        const owner = setup();
        expect(await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }))
            .toEqual({ kind: 'idle', since: 100 });
        owner.drain.beginTemporaryDrain();
        owner.setTarget(false);
        await owner.call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' });
        expect(owner.drain.isQuiescing()).toBe(true);
        owner.drain.resume();
        expect(owner.drain.isQuiescing()).toBe(false);
        owner.inventory.dispose();
    });
});
