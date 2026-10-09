import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineWorkSummaryGetInputV1Schema, type MachineWorkSummaryGetResultV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { WorkerLoadObservationV1Schema, type WorkerLoadObservationV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';

import type { ManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

export type MachineWorkSummaryRpcOwner = Readonly<{
    target: Omit<RequesterWorkAttributionV1, 'accountId'>;
    custodianAccountId: string;
    activity: Pick<ManagedActivityInventory, 'read'>;
    /** Incumbent access-list reader bound to this Home and custodian credential. */
    readAccess(signal: AbortSignal): Promise<unknown>;
    /** Pure observation of the same Project admission; never pumps accepted work. */
    readFiniteLoad?: () => Promise<WorkerLoadObservationV1>;
}>;

export function registerMachineWorkSummaryRpcHandlers(params: MachineWorkSummaryRpcOwner & Readonly<{
    rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
    const refused = (): MachineWorkSummaryGetResultV1 => ({ kind: 'refused', code: 'access_denied' });
    const current = async (context: RpcHandlerContext | undefined): Promise<boolean> => {
        const admission = context?.machineAdmission;
        if (!context || !admission || context.signal.aborted || !context.verifyMachineAdmissionCurrent
            || admission.machineId !== params.target.machineId || admission.installationId !== params.target.installationId
            || admission.custodianAccountId !== params.custodianAccountId
            || (admission.actorAccountId !== admission.custodianAccountId && admission.role !== 'manage')) return false;
        try { return await context.verifyMachineAdmissionCurrent() && !context.signal.aborted; }
        catch { return false; }
    };
    params.rpcHandlerManager.registerHandler(RPC_METHODS.MACHINES_WORK_SUMMARY_GET, async (raw: unknown, context): Promise<MachineWorkSummaryGetResultV1> => {
        const input = MachineWorkSummaryGetInputV1Schema.safeParse(raw);
        if (!input.success || input.data.serverId !== params.target.serverId || input.data.machineId !== params.target.machineId
            || !await current(context) || !context) return refused();
        try {
            const access = MachineAccessGrantsListResponseV1Schema.safeParse(await params.readAccess(context.signal));
            if (!await current(context)) return refused();
            if (!access.success || access.data.machineId !== params.target.machineId
                || access.data.custodian.accountId !== params.custodianAccountId || !access.data.canManage
                || access.data.access.accessState !== 'ready') return { kind: 'unavailable' };
            const inventory = await params.activity.read();
            if (!await current(context)) return refused();
            const summary = projectMachineWorkSummary({ inventory, target: params.target, custodianAccountId: params.custodianAccountId,
                requesterIdentities: new Map((access.data.currentRequesterDisplayIdentities ?? []).map(identity => [identity.accountId, identity])),
            });
            let finiteLoad: WorkerLoadObservationV1 = { kind: 'unknown' };
            try {
                const parsed = WorkerLoadObservationV1Schema.safeParse(await params.readFiniteLoad?.());
                if (parsed.success) finiteLoad = parsed.data;
            } catch { /* A missing observation cannot manufacture zero or weaken access. */ }
            if (!await current(context)) return refused();
            return { ...summary, finiteLoad };
        } catch {
            return await current(context) ? { kind: 'unavailable' } : refused();
        }
    });
}
