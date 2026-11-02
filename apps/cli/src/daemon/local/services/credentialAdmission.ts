import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";

/** Daemon HTTP credentials may serve only their actual Account, not a shared Machine actor. */
export async function assertLocalServiceCredentialAdmission(input: Readonly<{
    accountId?: string;
    machineId: string;
    context?: RpcHandlerContext;
}>): Promise<void> {
    const context = input.context;
    // Local calls use the daemon's own credentials. Transport authority is host-private.
    if (!context?.machineAdmission && !context?.authorization && !context?.transportRequestId) return;
    const admission = context.machineAdmission;
    const requester = context.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
        && context.workspaceSyncSourceExecution?.originalActionEnvelope
        ? readRequesterAccountActionContext(context.callerInputAuthorization) : null;
    const privateMove = requester?.authorization.binding.accountId === admission?.actorAccountId && await requester?.isCurrent();
    if (!input.accountId || !admission || admission.actorAccountId !== input.accountId && !privateMove
        || admission.machineId !== input.machineId || context.signal.aborted
        || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
        || context.signal.aborted) {
        throw new Error('requester_credentials_unavailable');
    }
}

export async function assertLocalServiceReadCustody(input: LocalServiceCredentialScope): Promise<void> {
    const context = input.context;
    // Local calls use the daemon's own credentials. Transport authority is host-private.
    if (!context?.machineAdmission && !context?.authorization && !context?.transportRequestId) return;
    const admission = context.machineAdmission;
    const requester = context.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
        && context.workspaceSyncSourceExecution?.originalActionEnvelope
        ? readRequesterAccountActionContext(context.callerInputAuthorization) : null;
    const privateMove = requester?.authorization.binding.accountId === admission?.actorAccountId && await requester?.isCurrent();
    if (!input.accountId || !admission || admission.actorAccountId !== input.accountId && !privateMove
        || admission.machineId !== input.machineId || context.signal.aborted
        || !context.verifyMachineAdmissionCurrent) {
        throw new Error('requester_credentials_unavailable');
    }
}

type LocalServiceCredentialScope = Readonly<{
    accountId?: string;
    machineId: string;
    context?: RpcHandlerContext;
}>;
