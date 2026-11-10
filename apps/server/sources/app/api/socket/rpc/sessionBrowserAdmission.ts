import type { Server } from 'socket.io';
import type { SocketRpcSessionBrowserAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import type { SessionAccessOperationDecision } from '@/app/session/access/sessionAccess';
import { projectSessionEffectiveAccessV1, resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { db } from '@/storage/db';
import { resolveCurrentSessionMachineFromServer } from '../externalActionDispatcher';

/** Session sharing admits only this Browser and selects its installed destination. */
export async function resolveSessionBrowserAdmission(input: Readonly<{
    actorAccountId: string;
    sessionId: string;
    capability: 'readTranscript' | 'submitAgentInput';
    authentication: SessionAccessAuthentication;
    io: Server;
    presence?: Parameters<typeof resolveCurrentSessionMachineFromServer>[0]['presence'];
}>): Promise<Exclude<SessionAccessOperationDecision, { status: 'allowed' }>
    | Readonly<{ status: 'allowed'; authorization: SocketRpcSessionBrowserAuthorizationContext }>> {
    const decision = await resolveSessionAccessForOperation(db, {
        accountId: input.actorAccountId, sessionId: input.sessionId,
        capability: input.capability, authentication: input.authentication,
    });
    if (decision.status !== 'allowed') return decision;
    const session = await db.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true } });
    if (!session) return { status: 'unavailable' as const };
    const committed = await readCurrentCommittedSessionInputMachineTargetInTx(db, input.sessionId, { admittedWork: true });
    const machineId = committed?.machineId ?? await resolveCurrentSessionMachineFromServer({
        io: input.io, presence: input.presence, accountId: session.accountId, sessionId: input.sessionId,
    });
    if (!machineId) return { status: 'unavailable' as const };
    const machine = await db.machine.findUnique({ where: { id: machineId },
        select: { accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true } });
    if (!machine?.installationId || classifyMachineAvailabilityState(machine) !== 'available'
        || committed && machine.installationId !== committed.installationId) return { status: 'unavailable' as const };
    return { status: 'allowed' as const, authorization: {
        kind: 'session.browser' as const,
        sessionId: input.sessionId,
        actorAccountId: input.actorAccountId,
        custodianAccountId: machine.accountId,
        machineId,
        installationId: machine.installationId,
        effectiveAccess: projectSessionEffectiveAccessV1(decision.access),
    } };
}
