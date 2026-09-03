import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildPendingChangedUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { SESSION_MESSAGE_USER_ATTENTION_IMPACT } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";

export async function emitPendingChanged(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
    meaningfulActivityAt?: Date | null;
    participantCursors: Array<{ accountId: string; cursor: number }>;
    activationTarget?: Readonly<{ accountId: string; requestId: string }>;
}): Promise<void> {
    const authorizationRow = await db.session.findUnique({
        where: { id: params.sessionId },
        select: {
            lastActiveAt: true,
            pendingActivationRequestId: true,
            pendingActivationRequestedAt: true,
            pendingActivationStatus: true,
            pendingActivationFailureCode: true,
        },
    });
    const pendingActivationAuthorization = authorizationRow
        ? (mapPendingActivationAuthorization(authorizationRow) ?? null)
        : null;
    const results = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildPendingChangedUpdate(
                {
                    sessionId: params.sessionId,
                    pendingCount: params.pendingCount,
                    ...(typeof params.pendingBlockedCount === "number" ? { pendingBlockedCount: params.pendingBlockedCount } : {}),
                    pendingVersion: params.pendingVersion,
                    meaningfulActivityAt: params.meaningfulActivityAt,
                    changedByAccountId: params.changedByAccountId,
                    pendingActivationAuthorization,
                },
                cursor,
                randomKeyNaked(12),
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-publication", level: "warn", sessionId: params.sessionId, accountId },
            "failed to emit pending-changed update",
            result.reason,
        );
    });
    if (params.activationTarget) {
        await emitPendingActivationHint({ ...params, activationTarget: params.activationTarget });
    }
}

/** Emits the lossy machine-scoped wake hint; durable Session authorization remains authoritative. */
export async function emitPendingActivationHint(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
    meaningfulActivityAt?: Date | null;
    participantCursors: Array<{ accountId: string; cursor: number }>;
    activationTarget: Readonly<{ accountId: string; requestId: string }>;
}): Promise<void> {
    const ownerCursor = params.participantCursors.find(
        ({ accountId }) => accountId === params.activationTarget.accountId,
    )?.cursor;
    if (typeof ownerCursor !== "number") return;
    const payload = buildPendingChangedUpdate(
        {
            sessionId: params.sessionId,
            pendingCount: params.pendingCount,
            ...(typeof params.pendingBlockedCount === "number"
                ? { pendingBlockedCount: params.pendingBlockedCount }
                : {}),
            pendingVersion: params.pendingVersion,
            meaningfulActivityAt: params.meaningfulActivityAt,
            changedByAccountId: params.changedByAccountId,
            pendingActivationRequestId: params.activationTarget.requestId,
        },
        ownerCursor,
        randomKeyNaked(12),
    );
    eventRouter.emitUpdate({
        userId: params.activationTarget.accountId,
        payload,
        recipientFilter: { type: "user-machine-scoped-only" },
    });
}

type PendingResolvedMessage = Parameters<typeof buildNewMessageUpdate>[0];

export async function emitPendingResolvedMessage(params: {
    sessionId: string;
    message: PendingResolvedMessage | undefined;
    eventKind?: "new-message" | "message-updated";
    readyProjection?: Parameters<typeof publishSessionReadyProjectionUpdate>[0]["readyProjection"];
    participantCursors: Array<{ accountId: string; cursor: number }>;
    logContext: string;
}): Promise<void> {
    if (!params.message || params.participantCursors.length === 0) return;
    const buildMessageUpdate = params.eventKind === "message-updated"
        ? buildMessageUpdatedUpdate
        : buildNewMessageUpdate;
    const messageResults = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildMessageUpdate(
                params.message!,
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                { attentionImpact: SESSION_MESSAGE_USER_ATTENTION_IMPACT },
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    messageResults.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-publication", level: "warn", sessionId: params.sessionId, accountId },
            params.logContext,
            result.reason,
        );
    });
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: params.readyProjection,
    });
}

export async function publishPendingMutationBadgeRefresh(params: Parameters<typeof refreshSessionParticipantBadgePushes>[0]): Promise<void> {
    await refreshSessionParticipantBadgePushes(params);
}
