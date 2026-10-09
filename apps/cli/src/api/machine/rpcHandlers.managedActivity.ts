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
        && drainedTarget.controller.machineId === target.controller.machineId
        && drainedTarget.controller.installationId === target.controller.installationId;
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
    params.rpcHandlerManager.registerHandler(MANAGED_ACTIVITY_READ_RPC_METHOD, async (raw: unknown, context) => {
        const parsed = ManagedActivityReadRequestV1Schema.safeParse(raw);
        if (!parsed.success || !await currentAdmission(context) || !context) return refused();
        if (!await currentTarget(parsed.data, context, MANAGED_ACTIVITY_READ_RPC_METHOD)) {
            release(parsed.data); return refused();
        }
        const decision = await params.activity.readDecision();
        if (!await currentAdmission(context) || !await currentTarget(parsed.data, context, MANAGED_ACTIVITY_READ_RPC_METHOD)) {
            release(parsed.data); return refused();
        }
        return decision;
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
        if (params.admissionDrain.isFinalShutdown()
            || !await currentTarget(target, context, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD)) return refused();
        drainedTarget = target;
        params.admissionDrain.beginUnusedStopDrain();
        try {
            const decision = await params.activity.readDecision();
            if (!await currentAdmission(context)
                || !await currentTarget(target, context, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD)) {
                release(target); return refused();
            }
            if (decision.kind !== 'idle') release(target);
            else if (params.commitIdleEvidence) {
                const evidence = params.commitIdleEvidence(target, decision, context);
                if (!evidence || !await currentAdmission(context)
                    || !await currentTarget(target, context, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD)) {
                    release(target); return refused();
                }
                return { ...decision, evidence };
            }
            return decision;
        } catch (error) { release(target); throw error; }
    });
}
