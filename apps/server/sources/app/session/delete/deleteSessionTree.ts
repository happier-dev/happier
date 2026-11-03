import { getDbProviderFromEnv } from '@/storage/prisma';
import { publishNativeCredentialPolicyChangesInTx } from '@/app/teams/credentials/nativePolicyChanges';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { notifySessionTranscriptMutationAfterCommit } from '../sessionTranscriptMutationObserver';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { invalidateSessionFollowDestinationsForSessionDeleteInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { invalidateSessionManagerForSessionDeleteInTx } from '@/app/session/follow/sessionManagerService';
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { resolveSessionGrantedAccountIdsInTx } from '@/app/session/access/sessionRecipients';

export class SessionDeleteConditionLostError extends Error {
    constructor() {
        super('Session no longer matches delete conditions');
        this.name = 'SessionDeleteConditionLostError';
    }
}

export async function deleteSessionTree(
    tx: Tx,
    params: {
        sessionId: string;
        sessionUpdatedAt: Date;
        actorAccountId: string;
        reason: 'user_request' | 'retention_policy';
        sessionDeleteWhere?: Prisma.SessionWhereInput;
        afterSessionWriteBoundary?: () => Promise<void>;
    },
): Promise<{
    deletedMessages: number;
    deletedReports: number;
    deletedAccessKeys: number;
}> {
    const [grantedAccountIds, followEdges, managerEdges] = await Promise.all([
        resolveSessionGrantedAccountIdsInTx(tx, { sessionId: params.sessionId }),
        tx.sessionFollowEdge.findMany({
            where: { sourceSessionId: params.sessionId },
            select: { destinationSessionId: true },
        }),
        tx.sessionFollowEdge.findMany({
            where: { relation: 'manager', OR: [{ sourceSessionId: params.sessionId }, { destinationSessionId: params.sessionId }] },
            select: { sourceSessionId: true, destinationSessionId: true },
        }),
    ]);
    await acquireSessionAccountCursorLocksInTx(tx, [
        params.sessionId,
        ...followEdges.map(edge => edge.destinationSessionId),
        ...managerEdges.filter(hasSessionFollowSessionSource).flatMap(edge => [edge.sourceSessionId, edge.destinationSessionId]),
    ], grantedAccountIds, { includeLifecyclePublications: true });
    // PostgreSQL's ordinary Session lock is NO KEY UPDATE, compatible with a
    // new binding's FK KEY SHARE. Upgrade this exact parent before the native
    // policy publication so an already-accepted row cannot hide until cascade.
    // MySQL admission already holds FOR UPDATE; SQLite serializes writers.
    if (getDbProviderFromEnv(process.env, 'postgres') === 'postgres') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Session" WHERE "id" = $1 FOR UPDATE', params.sessionId);
    }
    await publishNativeCredentialPolicyChangesInTx(tx, { sessionIds: [params.sessionId] });
    const sessionWhere = params.sessionDeleteWhere
        ? {
            AND: [
                { id: params.sessionId },
                params.sessionDeleteWhere,
            ],
        }
        : { id: params.sessionId };

    // Transcript writers allocate Session.seq before inserting their child row. Crossing the same
    // row-write boundary first lets earlier writers commit before the child sweep and makes later
    // writers wait until the parent has been deleted. The increment is not externally observable:
    // this row is deleted in the same transaction, or the transaction rolls it back.
    const claimedSession = await tx.session.updateMany({
        where: sessionWhere,
        data: {
            seq: { increment: 1 },
            updatedAt: params.sessionUpdatedAt,
        },
    });
    if (claimedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }
    await params.afterSessionWriteBoundary?.();

    const runnerActivation = await tx.ephemeralRunnerActivation.findFirst({
        where: { sessionId: params.sessionId, state: 'materialized' },
        select: { id: true, creatorAccountId: true, machineId: true },
    });

    const deletedMessages = await tx.sessionMessage.deleteMany({
        where: { sessionId: params.sessionId },
    });

    const deletedReports = await tx.usageReport.deleteMany({
        where: { sessionId: params.sessionId },
    });

    let revokedRunnerAccessKeys = 0;
    if (runnerActivation) {
        // Revoke while the AccessKey tuple still exists so the canonical
        // Machine mutation can identify and disconnect both exact restricted
        // socket profiles after commit. The following generic Session sweep is
        // retained for ordinary Machine tuples.
        const revokedRunner = await revokeMachineInTx(tx, {
            accountId: runnerActivation.creatorAccountId,
            machineId: runnerActivation.machineId,
        });
        if (!revokedRunner.ok) {
            throw new Error('Materialized ephemeral Runner Machine disappeared during Session deletion');
        }
        revokedRunnerAccessKeys = revokedRunner.deletedAccessKeys;
        await tx.ephemeralRunnerActivation.delete({ where: { id: runnerActivation.id } });
        await tx.machine.deleteMany({ where: {
            id: runnerActivation.machineId,
            accountId: runnerActivation.creatorAccountId,
            kind: 'ephemeral_session_runner',
        } });
    }

    const deletedAccessKeys = await tx.accessKey.deleteMany({
        where: { sessionId: params.sessionId },
    });

    await invalidateSessionFollowDestinationsForSessionDeleteInTx(tx, {
        sessionId: params.sessionId,
    });
    await invalidateSessionManagerForSessionDeleteInTx(tx, { sessionId: params.sessionId });

    const deletedSession = await tx.session.deleteMany({
        where: sessionWhere,
    });
    if (deletedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }

    notifySessionTranscriptMutationAfterCommit(tx, {
        kind: 'remove-session',
        sessionId: params.sessionId,
    });

    return {
        deletedMessages: deletedMessages.count,
        deletedReports: deletedReports.count,
        // Runner Machine revocation deliberately removes its tuple before the
        // generic sweep so established exact sockets can be found and evicted.
        // Report the complete Session deletion outcome rather than only the
        // rows left for the final sweep.
        deletedAccessKeys: revokedRunnerAccessKeys + deletedAccessKeys.count,
    };
}
