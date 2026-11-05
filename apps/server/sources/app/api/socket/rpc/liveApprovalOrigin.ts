import type { Socket } from 'socket.io';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { readCurrentSocketCredential } from '../socketCredentialCurrentness';
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from './_types';

/** The waiting CLI uses ordinary Account transport, including terminal automation credentials. */
export function isOrdinaryLiveApprovalOriginSocket(socket: Readonly<{ data?: Record<string, unknown> }>): boolean {
    const data = socket.data;
    return data?.clientType === 'user-scoped'
        && (data.authTokenKind === 'account' || data.authTokenKind === 'terminal')
        && data.ephemeralRunnerAdmission == null && data.apiTokenPrincipal == null;
}

export function isPresentUserLiveApprovalOriginCaller(socket: Socket): boolean {
    return socket.connected === true && isOrdinaryLiveApprovalOriginSocket(socket)
        && socket.data.authAuthority === 'present_user';
}

/** Keep approval decisions on the incumbent relay, with no receiver-selection fallback. */
export function createLiveApprovalOriginTargetGuard(input: Readonly<{
    userId: string;
    socket: Socket;
}>): RpcForwardTargetGuard {
    return {
        filterTargets: async targets => {
            const distinct = new Map<string, RpcAckResponseEmitter>();
            for (const target of targets) {
                if (target.id !== input.socket.id && isOrdinaryLiveApprovalOriginSocket(target)) {
                    distinct.set(target.id, target);
                }
            }
            return distinct.size === 1 ? [...distinct.values()] : [];
        },
        runOperation: async ({ target, operation, readLatestTarget }) => {
            const latest = await readLatestTarget();
            if (!latest || latest.id !== target.id || !isOrdinaryLiveApprovalOriginSocket(latest)) {
                return { status: 'unavailable' };
            }
            // The cluster receiver projection carries no credential. Its existing
            // socket revocation and CLI replay owners retain receiver currentness.
            // Revalidate the deciding caller last, immediately before dispatch.
            const credential = await readCurrentSocketCredential(input.userId, input.socket);
            if (!credential || narrowCredentialAuthority(credential.authority,
                input.socket.handshake.auth.authorityCeiling) !== 'present_user'
                || !isPresentUserLiveApprovalOriginCaller(input.socket)) {
                return { status: 'refused', response: { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN } };
            }
            return { status: 'current', value: await operation() };
        },
    };
}
