import type { Server } from 'socket.io';
import type { SocketRpcSessionWriteClassificationV1 } from '@happier-dev/protocol/socketRpc';
import type { VerifiedApiTokenPrincipal } from '@/app/auth/auth';
import { admitApiTokenSessionOperation } from '@/app/api/utils/apiTokenRouteAdmission';
import { resolveSessionAccessForOperation, type SessionAccessOperationDecision } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { db } from '@/storage/db';
import { resolveCurrentSessionMachineFromServer } from '../externalActionDispatcher';

/** One credential and Session-access decision for singleton and batched RPC admission. */
export async function admitSessionRpc(input: Readonly<{
    actorAccountId: string;
    credentialAccountId: string;
    sessionId: string;
    rule: SocketRpcSessionWriteClassificationV1;
    authentication: SessionAccessAuthentication;
    tokenAuthentication: SessionAccessAuthentication;
    viewerPrincipal?: VerifiedApiTokenPrincipal;
    io: Server;
    presence?: Parameters<typeof resolveCurrentSessionMachineFromServer>[0]['presence'];
}>): Promise<SessionAccessOperationDecision> {
    const { rule, sessionId, viewerPrincipal } = input;
    const apiTokenAction = viewerPrincipal && rule.actionId ? {
        actionId: rule.actionId,
        targetMachineId: await resolveCurrentSessionMachineFromServer({
            io: input.io, presence: input.presence, accountId: input.credentialAccountId, sessionId,
        }),
    } : undefined;
    const tokenAdmission = viewerPrincipal && apiTokenAction
        ? await admitApiTokenSessionOperation({
            principal: viewerPrincipal, sessionId,
            ...apiTokenAction,
            ...(rule.authority === 'sessionOwner' ? {} : { capability: rule.authority }),
            authentication: input.tokenAuthentication,
        }) : null;
    if (viewerPrincipal && !tokenAdmission?.ok) return { status: 'unavailable' };
    const decision: SessionAccessOperationDecision = tokenAdmission?.ok
        ? { status: 'allowed', access: tokenAdmission.access }
        : await resolveSessionAccessForOperation(db, {
            accountId: input.actorAccountId,
            sessionId,
            authentication: input.authentication,
            ...(rule.authority === 'sessionOwner' ? {} : { capability: rule.authority }),
        });
    return decision.status === 'allowed' && rule.authority === 'sessionOwner' && decision.access.level !== 'owner'
        ? { status: 'unavailable' }
        : decision;
}
