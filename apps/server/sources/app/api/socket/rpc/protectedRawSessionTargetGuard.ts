import { isDeepStrictEqual } from 'node:util';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { inReadSnapshot } from '@/storage/inTx';
import { resolveMachineAdmissionFromFactsInTx } from '@/app/machines/machineAccess';
import type { MachineOperationRequesterContext } from '@/app/machines/machineOperationSupport';
import { readSessionScopedSocketBinding, readCurrentSessionScopedMachineAccessFactsInTx,
    hasCurrentSessionScopedMachineAccessInTx } from '../sessionScopedBinding';
import type { RestrictedSocketAdmission } from '../restrictedSocketAdmission';
import type { RpcForwardTargetGuard } from './_types';

type SocketDataCarrier = Readonly<{ data?: unknown }>;

function readSocketData(socket: SocketDataCarrier): Record<string, unknown> {
    return socket.data && typeof socket.data === 'object' && !Array.isArray(socket.data)
        ? socket.data as Record<string, unknown> : {};
}

function readSocketClientType(socket: SocketDataCarrier): string | null {
    const clientType = readSocketData(socket).clientType;
    return typeof clientType === 'string' ? clientType : null;
}

const forbidden = { ok: false, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN } as const;

/** Retained Session receivers never inherit non-owner support from a newer daemon. */
export function createProtectedRawSessionTargetGuard(params: Readonly<{
    method: string; actorAccountId: string; targetUserId: string; callerSocket: SocketDataCarrier;
    callerAuthority: MachineOperationRequesterContext['callerAuthority']; knownSessionSource: boolean;
    sessionTransferViewer?: Extract<RestrictedSocketAdmission, { kind: 'api-token-session-viewer' }>;
}>) {
    const separator = params.method.indexOf(':');
    if (separator <= 0) return null;
    const sessionId = params.method.slice(0, separator);
    const rpcMethod = params.method.slice(separator + 1);
    if (resolveMachineRpcRoutePolicy(rpcMethod).requesterExecutionIsolationRequired !== true) return null;
    const readBinding = (target: SocketDataCarrier) => {
        const sourceType = readSocketClientType(params.callerSocket);
        // A current API-token viewer is Account automation, not an Agent Session
        // deputy. Ingress has already admitted its exact attachment header/grant;
        // the same physical-custodian receipt below still governs every phase.
        const attachmentViewer = sourceType === 'session-scoped'
            && params.sessionTransferViewer?.sessionId === sessionId
            && params.sessionTransferViewer.principal.accountId === params.actorAccountId;
        if (params.knownSessionSource || sourceType !== 'user-scoped' && sourceType !== 'machine-scoped' && !attachmentViewer
            || readSocketClientType(target) !== 'session-scoped' || readSocketData(target).userId !== params.targetUserId) return null;
        const binding = readSessionScopedSocketBinding({ data: target.data });
        return binding?.proof === 'machine-access-key' && binding.sessionId === sessionId && binding.machineId ? binding : null;
    };
    return {
        targetGuard: {
            filterTargets: async targets => targets,
            runOperation: async ({ target, readLatestTarget, operation }) => {
                if (readSocketClientType(target) !== 'session-scoped') return { status: 'current', value: await operation() };
                const binding = readBinding(target);
                const latest = binding ? await readLatestTarget() : null;
                return !binding || !latest || !isDeepStrictEqual(binding, readBinding(latest))
                    ? { status: 'refused', response: forbidden }
                    : { status: 'current', value: await operation() };
            },
        } satisfies RpcForwardTargetGuard,
        // Called inside the selected target guard immediately before emit.
        // One exact-key facts read serves both binding and Machine admission.
        createMachineAdmission: async ({ target }: Readonly<{ target: SocketDataCarrier }>): Promise<SocketRpcMachineAdmissionContextV1 | null> => {
            if (readSocketClientType(target) !== 'session-scoped') return null;
            const binding = readBinding(target);
            const context = binding && await inReadSnapshot(async tx => {
                const facts = await readCurrentSessionScopedMachineAccessFactsInTx({ tx, accountId: params.targetUserId,
                    machineId: binding.machineId!, sessionId });
                if (!facts || facts.machine.accountId !== params.actorAccountId
                    || !await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: params.targetUserId,
                        machineId: binding.machineId!, sessionId, currentFacts: facts })) return null;
                const admission = await resolveMachineAdmissionFromFactsInTx(tx, facts.machine, {
                    actorAccountId: params.actorAccountId, machineId: binding.machineId!, rpcMethod,
                    callerAuthority: params.callerAuthority,
                });
                if (admission.kind !== 'admitted' || admission.custodianAccountId !== params.actorAccountId) return null;
                const { kind: _kind, ...receipt } = admission;
                return receipt;
            });
            if (!context) throw Object.assign(new Error(RPC_ERROR_MESSAGES.FORBIDDEN), { code: RPC_ERROR_CODES.FORBIDDEN });
            return context;
        },
    };
}
