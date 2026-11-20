import type { Server, Socket } from 'socket.io';
import { ManagedInstallationCapabilityRequestV1Schema, readManagedInstallationPurposeV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { admitManagedInstallationPurpose } from '@/app/machines/managed/managedInstallation';
import { ManagedMachineError } from '@/app/machines/managed/managedRows';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from '../machineSocketInstallationProof';
import { forwardRpcCall, type RpcForwardResult } from './forwardRpcCall';

/** A closed purpose on the incumbent capability transport; it grants no other Machine RPC. */
export async function forwardManagedInstallationResponse(input: Readonly<{
    io: Server; socket: Socket; actorAccountId: string; method: string; params: unknown; inboundAuthorization: unknown;
    timeoutMs: number | null | undefined; cancellation?: Parameters<typeof forwardRpcCall>[0]['cancellation'];
}>): Promise<RpcForwardResult | null> {
    const params = input.params;
    const candidate = params !== null && typeof params === 'object' && 'params' in params
        && params.params !== null && typeof params.params === 'object' && 'managedId' in params.params;
    if (!candidate) return null;
    const refused = { ok: false as const, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
    const parsed = ManagedInstallationCapabilityRequestV1Schema.safeParse(params);
    // The controller addresses the capability call; a controller-less response has no Machine to reach.
    if (!parsed.success || !parsed.data.params.controller || input.inboundAuthorization !== undefined
        || input.method !== `${parsed.data.params.controller.machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}`) return refused;
    const purpose = readManagedInstallationPurposeV1(parsed.data.params);
    const credential = input.socket.data;
    if (credential?.userId !== input.actorAccountId || credential.authAuthority !== 'present_user') return refused;
    const terminalPairing = credential.authTokenKind === 'terminal'
        && credential.clientType === 'user-scoped' && purpose.expectedPromptKind === 'auth.approveRemoteProvisioning';
    if (credential.authTokenKind !== 'account' && !terminalPairing) return refused;
    try {
        const authorization = await admitManagedInstallationPurpose({ actorAccountId: input.actorAccountId, purpose });
        const controller = authorization.purpose.controller;
        if (!controller) return refused;
        const matches = (target: Readonly<{ data?: Record<string, unknown> }>) => target.data?.clientType === 'machine-scoped'
            && target.data.machineId === controller.machineId
            && target.data.userId === authorization.custodianAccountId
            && readVerifiedMachineSocketInstallationIdFromSocketData(target.data) === controller.installationId;
        return await forwardRpcCall({ io: input.io, targetUserId: authorization.custodianAccountId, method: input.method,
            callParams: { ...parsed.data, params: { ...parsed.data.params, requestId: authorization.purpose.requestId } },
            authorization, timeoutMs: input.timeoutMs, callerSocketId: input.socket.id,
            ...(input.cancellation ? { cancellation: input.cancellation } : {}),
            targetGuard: { filterTargets: async targets => targets.filter(matches),
                runOperation: async ({ target, operation }) => matches(target)
                    ? { status: 'current', value: await operation() } : { status: 'refused', response: refused } },
        });
    } catch (error) { if (error instanceof ManagedMachineError) return refused; throw error; }
}
