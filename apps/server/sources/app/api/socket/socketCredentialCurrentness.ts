import type { Socket } from 'socket.io';
import type { VerifiedAuthToken } from '@/app/auth/auth';
import { isRestrictedAuthTokenKind } from '@/app/api/utils/apiTokenRouteAdmission';
import type { RestrictedSocketAdmission } from './restrictedSocketAdmission';

/**
 * Consume connect-time identity while this socket is live. Credential revocation
 * and PAT grant changes close sockets through connectionEventRouter's eviction
 * owner. Widened PAT permissions become available when the viewer reconnects.
 * These historical export names refer to connection currentness, not another
 * bearer verification or credential-row refresh on each packet.
 */
export async function readCurrentSocketCredential(userId: string, socket: Socket): Promise<VerifiedAuthToken | null> {
    if (socket.connected !== true || socket.data?.userId !== userId) return null;
    const data = socket.data;
    const admission: RestrictedSocketAdmission | undefined = data.ephemeralRunnerAdmission;
    if (isRestrictedAuthTokenKind(data.authTokenKind) && !admission) return null;
    return {
        userId, authTokenKind: data.authTokenKind, authority: data.authAuthority,
        tokenEpoch: data.tokenEpoch, authenticationEvidence: data.authTokenAuthenticationEvidence,
        legacy: data.authTokenLegacy === true,
        ...(admission?.kind === 'api-token-session-viewer' ? { apiTokenPrincipal: admission.principal } : {}),
        ...(admission && admission.kind !== 'api-token-session-viewer' ? { ephemeralSessionRunnerPrincipal: admission.principal } : {}),
    };
}

export async function hasCurrentSocketCredential(userId: string, socket: Socket): Promise<boolean> {
    return await readCurrentSocketCredential(userId, socket) !== null;
}
