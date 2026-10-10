import type { RpcHandlerContext } from '@/api/rpc/types';

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
    if (!input.accountId || !admission || admission.actorAccountId !== input.accountId
        || admission.machineId !== input.machineId || context.signal.aborted
        || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
        || context.signal.aborted) {
        throw new Error('requester_credentials_unavailable');
    }
}
