import type { Server, Socket } from 'socket.io';
import { ManagedInstallationCapabilityRequestV1Schema, readManagedInstallationPurposeV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { auth } from '@/app/auth/auth';
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
    if (!parsed.success || input.inboundAuthorization !== undefined
        || input.method !== `${parsed.data.params.controller.machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}`) return refused;
    const token = input.socket.handshake?.auth?.token;
    const credential = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
    if (!credential || credential.userId !== input.actorAccountId || credential.authTokenKind !== 'account'
        || credential.authority !== 'present_user') return refused;
    try {
        const authorization = await admitManagedInstallationPurpose({ actorAccountId: input.actorAccountId,
            purpose: readManagedInstallationPurposeV1(parsed.data.params) });
        const matches = (target: Readonly<{ data?: Record<string, unknown> }>) => target.data?.clientType === 'machine-scoped'
            && target.data.machineId === authorization.purpose.controller.machineId
            && target.data.userId === authorization.custodianAccountId
            && readVerifiedMachineSocketInstallationIdFromSocketData(target.data) === authorization.purpose.controller.installationId;
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
