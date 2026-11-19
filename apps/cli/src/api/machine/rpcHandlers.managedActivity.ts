import {
    MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityReadRequestV1Schema, ManagedAdmissionDrainConfirmRequestV1Schema,
    type ManagedActivityReadRequestV1, type ManagedActivityBridgeResultV1,
} from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import type { ManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import type { ManagedCommittedIdleEvidenceV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

export type ManagedActivityRpcOwner = Readonly<{
    activity: ManagedActivityInventory;
    admissionDrain: DaemonAdmissionDrain;
    commitIdleEvidence?: (target: ManagedActivityReadRequestV1, idle: Readonly<{ kind: 'idle'; since: number }>,
        context: RpcHandlerContext) => ManagedCommittedIdleEvidenceV1 | null;
}>;

export function registerManagedActivityRpcHandlers(params: ManagedActivityRpcOwner & Readonly<{
    rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
    let drainedTarget: ManagedActivityReadRequestV1 | null = null;
    const refused = (): ManagedActivityBridgeResultV1 => ({ kind: 'refused', code: 'admission_unavailable' });
    const sameTarget = (target: ManagedActivityReadRequestV1) => drainedTarget !== null
        && drainedTarget.homeId === target.homeId && drainedTarget.managedId === target.managedId
        && drainedTarget.expectedRevision === target.expectedRevision
        && drainedTarget.controller?.machineId === target.controller?.machineId
        && drainedTarget.controller?.installationId === target.controller?.installationId;
    const release = (target: ManagedActivityReadRequestV1) => {
        if (!sameTarget(target)) return;
        drainedTarget = null;
        params.admissionDrain.resumeUnusedStop();
    };
    const currentAdmission = async (context: RpcHandlerContext | undefined) => {
        if (!context?.machineAdmission || !context.verifyMachineAdmissionCurrent || context.signal.aborted) return false;
        try { return await context.verifyMachineAdmissionCurrent() && !context.signal.aborted; }
        catch { return false; }
    };
    const confirm = async (target: ManagedActivityReadRequestV1, context: RpcHandlerContext,
        probe: boolean): Promise<ManagedActivityBridgeResultV1> => {
        // The ingress verifier already admits this exact target at Home.
        if (context.signal.aborted || params.admissionDrain.isFinalShutdown()) return refused();
        // Each read holds a reversible drain. Only a successful native-effect
        // confirmation can retain the Stop gate, and probes cannot release it.
        const releaseRead = params.admissionDrain.beginTemporaryDrain();
        if (!probe) drainedTarget = target;
        const releaseOwned = () => {
            releaseRead();
            if (!probe && drainedTarget === target) release(target);
        };
        const onAbort = () => releaseOwned();
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (context.signal.aborted) { releaseOwned(); return refused(); }
            const decision = await params.activity.readDecision();
            if (context.signal.aborted || params.admissionDrain.isFinalShutdown() || (!probe && drainedTarget !== target)) {
                releaseOwned(); return refused();
            }
            if (decision.kind !== 'idle') {
                releaseOwned(); return decision;
            }
            const evidence = params.commitIdleEvidence?.(target, decision, context);
            if ((params.commitIdleEvidence && !evidence) || context.signal.aborted) {
                releaseOwned(); return refused();
            }
            if (!probe) params.admissionDrain.beginUnusedStopDrain();
            return evidence ? { ...decision, evidence } : decision;
        } catch (error) { releaseOwned(); throw error; }
        finally {
            context.signal.removeEventListener('abort', onAbort);
            releaseRead();
        }
    };
    params.rpcHandlerManager.registerHandler(MANAGED_ACTIVITY_READ_RPC_METHOD, async (raw: unknown, context) => {
        const parsed = ManagedActivityReadRequestV1Schema.safeParse(raw);
        if (!parsed.success || !await currentAdmission(context) || !context) return refused();
        return await confirm(parsed.data, context, true);
    });
    params.rpcHandlerManager.registerHandler(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, async (raw: unknown, context) => {
        const parsed = ManagedAdmissionDrainConfirmRequestV1Schema.safeParse(raw);
        if (!parsed.success || !await currentAdmission(context) || !context) return refused();
        const { action, ...target } = parsed.data;
        // A policy edit can invalidate the retained target while its exact
        // admitted custodian still needs to clear only that target's cause.
        if (action === 'resume') {
            release(target);
            return await params.activity.readDecision();
        }
        return await confirm(target, context, false);
    });
}
