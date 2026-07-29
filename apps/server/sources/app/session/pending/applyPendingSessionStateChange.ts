import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";

export async function applyPendingSessionStateChange(params: {
    tx: Tx;
    sessionId: string;
    pendingCountDelta?: number;
    pendingBlockedCountDelta?: number;
    meaningfulActivityAt?: Date;
    activationTarget?: Readonly<{ accountId: string; requestId: string }>;
}): Promise<{
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    participantCursors: SessionParticipantCursor[];
    badgeAttentionChanged: boolean;
    meaningfulActivityAt?: Date;
}> {
    const { tx, sessionId, meaningfulActivityAt } = params;
    const pendingCountDelta = typeof params.pendingCountDelta === "number" && Number.isInteger(params.pendingCountDelta)
        ? params.pendingCountDelta
        : 0;
    const pendingBlockedCountDelta = typeof params.pendingBlockedCountDelta === "number" && Number.isInteger(params.pendingBlockedCountDelta)
        ? params.pendingBlockedCountDelta
        : 0;
    const before = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            seq: true,
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
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

    const session = await applyPendingCounterUpdate({
        tx,
        sessionId,
        pendingCountDelta,
        pendingBlockedCountDelta,
        data: baseData,
        initialState: {
            pendingCount: before.pendingCount,
            pendingBlockedCount: before.pendingBlockedCount,
            pendingVersion: before.pendingVersion,
        },
    });

    const participantCursors = await markPendingStateChangedParticipants({
        tx,
        sessionId,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        meaningfulActivityAt,
        activationTarget: params.activationTarget,
    });

    return {
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingVersion: session.pendingVersion,
        participantCursors,
        badgeAttentionChanged: didSessionActivityBadgeContributionChange(before, {
            ...before,
            pendingCount: session.pendingCount,
            pendingBlockedCount: session.pendingBlockedCount,
        }),
        ...(meaningfulActivityAt instanceof Date && Number.isFinite(meaningfulActivityAt.getTime())
            ? { meaningfulActivityAt }
            : {}),
    };
}

type PendingCounterState = {
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
};

async function applyPendingCounterUpdate(params: {
    tx: Tx;
    sessionId: string;
    pendingCountDelta: number;
    pendingBlockedCountDelta: number;
    data: {
        pendingVersion: { increment: 1 };
        meaningfulActivityAt?: Date;
    };
    initialState: PendingCounterState;
}): Promise<PendingCounterState> {
    let current = params.initialState;
    let pendingCountDelta = params.pendingCountDelta;
    let pendingBlockedCountDelta = params.pendingBlockedCountDelta;

    for (let attempt = 0; attempt < 4; attempt += 1) {
        const nextPendingCount = Math.max(0, current.pendingCount + pendingCountDelta);
        const nextPendingBlockedCount = Math.max(0, current.pendingBlockedCount + pendingBlockedCountDelta);
        const updated = await params.tx.session.updateMany({
            where: {
                id: params.sessionId,
                pendingCount: current.pendingCount,
                pendingBlockedCount: current.pendingBlockedCount,
                pendingVersion: current.pendingVersion,
            },
            data: {
                ...params.data,
                pendingCount: nextPendingCount,
                pendingBlockedCount: nextPendingBlockedCount,
            },
        });

        if (updated.count > 0) {
            return params.tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
        }

        current = await params.tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        if (params.initialState.pendingCount <= 0 && params.pendingCountDelta < 0) {
            pendingCountDelta = 0;
        }
        if (params.initialState.pendingBlockedCount <= 0 && params.pendingBlockedCountDelta < 0) {
            pendingBlockedCountDelta = 0;
        }
    }

    const nextPendingCount = Math.max(0, current.pendingCount + pendingCountDelta);
    const nextPendingBlockedCount = Math.max(0, current.pendingBlockedCount + pendingBlockedCountDelta);
    return params.tx.session.update({
        where: { id: params.sessionId },
        data: {
            ...params.data,
            pendingCount: nextPendingCount,
            pendingBlockedCount: nextPendingBlockedCount,
        },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
}
