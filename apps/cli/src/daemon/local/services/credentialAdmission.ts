import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

type LocalServiceCredentialScope = Readonly<{
    accountId?: string;
    machineId: string;
    context?: RpcHandlerContext;
}>;

/** Finite metadata reads retain admitted Account custody and local cancellation. */
export async function assertLocalServiceReadCustody(
    input: LocalServiceCredentialScope,
    /** Read-only scope; credential-bearing callers retain the strict default. */
    readScope?: 'requester_managed_services' | 'machine_inventory',
): Promise<string | undefined> {
    const context = input.context;
    // Local calls use the daemon's own credentials. Transport authority is host-private.
    if (!context?.machineAdmission && !context?.authorization && !context?.transportRequestId) return;
    const admission = context.machineAdmission;
    const requester = context.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
        && context.workspaceSyncSourceExecution?.originalActionEnvelope
        ? readRequesterAccountActionContext(context.callerInputAuthorization) : null;
    const privateMove = requester?.authorization.binding.accountId === admission?.actorAccountId && await requester?.isCurrent();
    const requesterOnly = readScope === 'requester_managed_services' && admission
        && admission.actorAccountId !== input.accountId && !privateMove;
    if (!input.accountId || !admission || admission.machineId !== input.machineId || context.signal.aborted
        || !context.verifyMachineAdmissionCurrent) {
        throw new Error('requester_credentials_unavailable');
    }
    if (admission.actorAccountId !== input.accountId && !privateMove && !requesterOnly) {
        if (readScope === 'machine_inventory') {
            throw new RpcError('requester_credentials_unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        }
        throw new Error('requester_credentials_unavailable');
    }
    return requesterOnly ? admission.actorAccountId : undefined;
}

/** Credential-bearing finite work retains admitted Account custody and checks local cancellation. */
export async function assertLocalServiceCredentialAdmission(input: LocalServiceCredentialScope): Promise<void> {
    await assertLocalServiceReadCustody(input);
    const context = input.context;
    if (!context?.machineAdmission && !context?.authorization && !context?.transportRequestId) return;
    if (!context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent() || context.signal.aborted) {
        throw new Error('requester_credentials_unavailable');
    }
}
