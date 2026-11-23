import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { StoredCredentials } from '@/persistence';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { MachineAccessRefusalCodeV1 } from '@happier-dev/protocol/machines/machineAccessV1';

/** This daemon reads and writes Services with its owner's Account; a guest's raw call is the owner's alone. */
const CUSTODIAN_ONLY = 'custodian_only' satisfies MachineAccessRefusalCodeV1;

export type LocalServiceActionCredentials =
    | Readonly<{ ok: true; credentials: StoredCredentials }>
    | Readonly<{ ok: false; errorCode: typeof CUSTODIAN_ONLY | 'requester_credentials_unavailable' }>;

/** Credential selection for the receiving Services Action factory. */
export async function resolveLocalServiceActionCredentials(input: Readonly<{
    credentials: StoredCredentials;
    readCredentials: () => Promise<StoredCredentials | null>;
    actorAccountId: string;
    requester: Pick<RequesterAccountActionContext, 'credentials'> | null;
}>): Promise<LocalServiceActionCredentials> {
    const unavailable = { ok: false, errorCode: 'requester_credentials_unavailable' } as const;
    if (input.requester) {
        return readAccountIdFromToken(input.requester.credentials.token) === input.actorAccountId
            ? { ok: true, credentials: input.requester.credentials } : unavailable;
    }
    // Without the caller's own custody only this daemon's Account can act, which is the owner's.
    if (readAccountIdFromToken(input.credentials.token) !== input.actorAccountId) return { ok: false, errorCode: CUSTODIAN_ONLY };
    const credentials = await input.readCredentials().catch(() => null);
    return credentials && credentials.token === input.credentials.token
        && readAccountIdFromToken(credentials.token) === input.actorAccountId ? { ok: true, credentials } : unavailable;
}

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
    // The Services ingress lent an admitted guest their own Session's custody: it lets them act, and
    // they read only as that requester (the reader pins it to that Session), never the Machine view.
    const ownSession = !!admission && context.requesterSessionBootstrap?.attribution.accountId === admission.actorAccountId;
    const guest = !!admission && admission.actorAccountId !== input.accountId && !privateMove;
    const requesterOnly = guest && (readScope === 'requester_managed_services' || ownSession && readScope !== 'machine_inventory');
    if (!input.accountId || !admission || admission.machineId !== input.machineId || context.signal.aborted
        || !context.verifyMachineAdmissionCurrent) {
        throw new Error('requester_credentials_unavailable');
    }
    if (guest && !requesterOnly) {
        if (readScope === 'machine_inventory') {
            throw new RpcError('requester_credentials_unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        }
        throw new RpcError('requester_credentials_unavailable', CUSTODIAN_ONLY);
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
