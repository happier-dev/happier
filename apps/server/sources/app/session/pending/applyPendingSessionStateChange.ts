import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { markPendingStateChangedRecipients } from "@/app/session/pending/markPendingStateChangedRecipients";
import type { SessionRecipientPublication } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import type { Tx } from "@/storage/inTx";
import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

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
    recipientCursors: SessionRecipientPublication[];
    badgeAttentionChanged: boolean;
    meaningfulActivityAt?: Date;
}> {
    const { tx, sessionId, meaningfulActivityAt } = params;
    await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
    const pendingCountDelta = typeof params.pendingCountDelta === "number" && Number.isInteger(params.pendingCountDelta)
        ? params.pendingCountDelta
        : 0;
    const pendingBlockedCountDelta = typeof params.pendingBlockedCountDelta === "number" && Number.isInteger(params.pendingBlockedCountDelta)
        ? params.pendingBlockedCountDelta
        : 0;
    const before = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: withSessionContentSelect({
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        }),
    }).then(decodeSessionStoredContent);
    const baseData: {
        pendingVersion: { increment: 1 };
        meaningfulActivityAt?: Date;
    } = {
        pendingVersion: { increment: 1 },
    };
    if (meaningfulActivityAt instanceof Date && Number.isFinite(meaningfulActivityAt.getTime())) {
        baseData.meaningfulActivityAt = meaningfulActivityAt;
    }

    // The Session resource lock above (SQLite: the single writer) holds this row
    // from the read through the write, so the counters are written from `before`.
    const session = await tx.session.update({
        where: { id: sessionId },
        data: {
            ...baseData,
            pendingCount: Math.max(0, before.pendingCount + pendingCountDelta),
            pendingBlockedCount: Math.max(0, before.pendingBlockedCount + pendingBlockedCountDelta),
        },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });

    const recipientCursors = await markPendingStateChangedRecipients({
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
        recipientCursors,
        badgeAttentionChanged: didSessionActivityBadgeSignalChange(before, {
            ...before,
            pendingCount: session.pendingCount,
            pendingBlockedCount: session.pendingBlockedCount,
        }),
        ...(meaningfulActivityAt instanceof Date && Number.isFinite(meaningfulActivityAt.getTime())
            ? { meaningfulActivityAt }
            : {}),
    };
}
