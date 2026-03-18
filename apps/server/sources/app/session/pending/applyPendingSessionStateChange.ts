import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";

export async function applyPendingSessionStateChange(params: {
    tx: Tx;
    sessionId: string;
    pendingCountDelta?: -1 | 0 | 1;
}): Promise<{ pendingCount: number; pendingVersion: number; participantCursors: SessionParticipantCursor[]; badgeAttentionChanged: boolean }> {
    const { tx, sessionId, pendingCountDelta } = params;
    const before = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            seq: true,
            pendingCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    const data: { pendingVersion: { increment: 1 }; pendingCount?: { increment: 1 } | { decrement: 1 } } = {
        pendingVersion: { increment: 1 },
    };

    if (pendingCountDelta === 1) {
        data.pendingCount = { increment: 1 };
    } else if (pendingCountDelta === -1) {
        data.pendingCount = { decrement: 1 };
    }

    const session = await tx.session.update({
        where: { id: sessionId },
        data,
        select: { pendingCount: true, pendingVersion: true },
    });

    const participantCursors = await markPendingStateChangedParticipants({
        tx,
        sessionId,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
    });

    return {
        pendingCount: session.pendingCount,
        pendingVersion: session.pendingVersion,
        participantCursors,
        badgeAttentionChanged: didSessionActivityBadgeContributionChange(before, {
            ...before,
            pendingCount: session.pendingCount,
        }),
    };
}
