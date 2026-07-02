import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";

export async function applyPendingSessionStateChange(params: {
    tx: Tx;
    sessionId: string;
    pendingCountDelta?: -1 | 0 | 1;
    meaningfulActivityAt?: Date;
}): Promise<{
    pendingCount: number;
    pendingVersion: number;
    participantCursors: SessionParticipantCursor[];
    badgeAttentionChanged: boolean;
    meaningfulActivityAt?: Date;
}> {
    const { tx, sessionId, pendingCountDelta, meaningfulActivityAt } = params;
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
    const baseData: {
        pendingVersion: { increment: 1 };
        meaningfulActivityAt?: Date;
    } = {
        pendingVersion: { increment: 1 },
    };
    if (meaningfulActivityAt instanceof Date && Number.isFinite(meaningfulActivityAt.getTime())) {
        baseData.meaningfulActivityAt = meaningfulActivityAt;
    }

    let session: { pendingCount: number; pendingVersion: number };

    if (pendingCountDelta === -1) {
        const decremented = await tx.session.updateMany({
            where: { id: sessionId, pendingCount: { gt: 0 } },
            data: {
                ...baseData,
                pendingCount: { decrement: 1 },
            },
        });

        if (decremented.count > 0) {
            session = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: { pendingCount: true, pendingVersion: true },
            });
        } else {
            const clamped = await tx.session.updateMany({
                where: { id: sessionId, pendingCount: { lte: 0 } },
                data: {
                    ...baseData,
                    pendingCount: 0,
                },
            });

            session = clamped.count > 0
                ? await tx.session.findUniqueOrThrow({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingVersion: true },
                })
                : await tx.session.update({
                    where: { id: sessionId },
                    data: baseData,
                    select: { pendingCount: true, pendingVersion: true },
                });
        }
    } else {
        const data: {
            pendingVersion: { increment: 1 };
            pendingCount?: { increment: 1 };
            meaningfulActivityAt?: Date;
        } = { ...baseData };

        if (pendingCountDelta === 1) {
            data.pendingCount = { increment: 1 };
        }

        session = await tx.session.update({
            where: { id: sessionId },
            data,
            select: { pendingCount: true, pendingVersion: true },
        });
    }

    const participantCursors = await markPendingStateChangedParticipants({
        tx,
        sessionId,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        meaningfulActivityAt,
    });

    return {
        pendingCount: session.pendingCount,
        pendingVersion: session.pendingVersion,
        participantCursors,
        badgeAttentionChanged: didSessionActivityBadgeContributionChange(before, {
            ...before,
            pendingCount: session.pendingCount,
        }),
        ...(meaningfulActivityAt instanceof Date && Number.isFinite(meaningfulActivityAt.getTime())
            ? { meaningfulActivityAt }
            : {}),
    };
}
