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
    /** The authenticated guest transport checks the exact retained row at its Home owner. */
    validateCurrentTarget(target: ManagedActivityReadRequestV1, context: RpcHandlerContext,
        method: string): Promise<boolean>;
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
    const currentTarget = async (target: ManagedActivityReadRequestV1, context: RpcHandlerContext, method: string) => {
        try { return !context.signal.aborted && await params.validateCurrentTarget(target, context, method)
            && !context.signal.aborted; }
        catch { return false; }
    };
    const confirm = async (target: ManagedActivityReadRequestV1, context: RpcHandlerContext,
        method: string, probe: boolean): Promise<ManagedActivityBridgeResultV1> => {
        if (params.admissionDrain.isFinalShutdown()
            || !await currentTarget(target, context, method)) return refused();
        // A read owns a reversible probe only. Never borrow or release a
        // concurrent final native-effect confirmation's retained drain.
        const ownsDrain = !probe || drainedTarget === null;
        if (ownsDrain) {
            drainedTarget = target;
            params.admissionDrain.beginUnusedStopDrain();
        }
        const releaseOwned = () => { if (ownsDrain && drainedTarget === target) release(target); };
        const onAbort = () => releaseOwned();
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (context.signal.aborted) { releaseOwned(); return refused(); }
            const decision = await params.activity.readDecision();
            if (!await currentAdmission(context)
                || !await currentTarget(target, context, method)) {
                releaseOwned(); return refused();
            }
            if (decision.kind !== 'idle') releaseOwned();
            else if (params.commitIdleEvidence) {
                const evidence = params.commitIdleEvidence(target, decision, context);
                if (!evidence || !await currentAdmission(context)
                    || !await currentTarget(target, context, method)) {
                    releaseOwned(); return refused();
                }
                return { ...decision, evidence };
            }
            return decision;
        } catch (error) { releaseOwned(); throw error; }
        finally {
            context.signal.removeEventListener('abort', onAbort);
            if (probe) releaseOwned();
        }
    };
    params.rpcHandlerManager.registerHandler(MANAGED_ACTIVITY_READ_RPC_METHOD, async (raw: unknown, context) => {
        const parsed = ManagedActivityReadRequestV1Schema.safeParse(raw);
        if (!parsed.success || !await currentAdmission(context) || !context) return refused();
        return await confirm(parsed.data, context, MANAGED_ACTIVITY_READ_RPC_METHOD, true);
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
        return await confirm(target, context, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, false);
    });
}
