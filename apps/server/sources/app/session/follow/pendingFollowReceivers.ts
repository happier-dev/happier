import { compareSessionFollowFrontierProgressV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { SessionFollowPendingReceiversResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { readCurrentSourceSessionFollowFrontier, readStoredSessionFollowFrontier } from '@/app/session/relations/sessionEdgeFrontier';
import { observePendingSessionFollowForInactiveDestinationInTx } from './sessionFollowEdgeService';
import { readPendingStalledSessionFollowReceiverIdsInTx } from './sessionFollowStalledRule';

type ReceiverScope = Omit<Parameters<typeof observePendingSessionFollowForInactiveDestinationInTx>[1], 'destinationSessionId'>;

/** Existing frontiers narrow discovery; the observation owner alone admits actual work and placement. */
export async function readPendingFollowReceiversInTx(tx: Tx, input: ReceiverScope): Promise<SessionFollowPendingReceiversResponseV1> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { destinationSession: { accountId: input.accountId, archivedAt: null } },
        select: { destinationSessionId: true, deliveredTranscriptSeq: true, deliveredReadyEventSeq: true,
            deliveredAgentStateVersion: true, deliveredTurnId: true, deliveredTurnStatus: true,
            sourceSession: { select: { seq: true, latestReadyEventSeq: true, agentStateVersion: true,
                latestTurnId: true, latestTurnStatus: true, active: true, archivedAt: true } },
            sourceDiscussion: { select: { messageSeq: true, archivedAt: true } } },
    });
    const candidates = new Set(await readPendingStalledSessionFollowReceiverIdsInTx(tx, input));
    for (const edge of edges) {
        if (edge.sourceSession?.archivedAt === null && compareSessionFollowFrontierProgressV1(
            readStoredSessionFollowFrontier(edge), readCurrentSourceSessionFollowFrontier(edge.sourceSession),
        ) === 'ahead' || edge.sourceDiscussion?.archivedAt === null
            && edge.sourceDiscussion.messageSeq > edge.deliveredTranscriptSeq) candidates.add(edge.destinationSessionId);
    }
    const sessionIds: string[] = [];
    for (const destinationSessionId of candidates) {
        const observed = await observePendingSessionFollowForInactiveDestinationInTx(tx, { ...input, destinationSessionId });
        if (observed.ok && observed.observations.length) sessionIds.push(destinationSessionId);
    }
    return { ok: true, v: 1, sessionIds: sessionIds.sort() };
}

/** Reconnect is the natural recovery boundary; no new stored work marker is needed. */
export async function readPendingFollowReceivers(input: ReceiverScope): Promise<SessionFollowPendingReceiversResponseV1> {
    return inReadSnapshot(tx => readPendingFollowReceiversInTx(tx, input));
}
