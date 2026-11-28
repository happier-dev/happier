import type { AcceptedPendingSettlementRequestV2 } from "@happier-dev/protocol";
import { log } from "@/utils/logging/log";
import {
    resolveAcceptedPendingDelivery,
    type ResolveAcceptedPendingDeliveryResult,
} from "@/app/session/pending/pendingMessageService";
import type { TrustedPendingPublisherFence } from "@/app/session/pending/pendingPublisherAuthority";
import {
    emitPendingChanged,
    emitPendingResolvedMessage,
    publishPendingMutationBadgeRefresh,
} from "@/app/session/pending/publishPendingMutation";

type PublishAcceptedPendingSettlement = (params: Readonly<{
    actorUserId: string;
    sessionId: string;
    result: ResolveAcceptedPendingDeliveryResult;
}>) => Promise<void>;

export async function publishAcceptedPendingSettlement(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    result: ResolveAcceptedPendingDeliveryResult;
}>): Promise<void> {
    const { result } = params;
    if (!result.ok) {
        if (result.error !== "transcript-conflict" || result.pendingStateChanged !== true) return;
        const participantCursors = result.participantCursors ?? [];
        await emitPendingChanged({
            sessionId: params.sessionId,
            changedByAccountId: params.actorUserId,
            pendingCount: result.pendingCount ?? 0,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion ?? 0,
            participantCursors,
        });
        await publishPendingMutationBadgeRefresh({
            badgeAttentionChanged: result.badgeAttentionChanged ?? false,
            participantCursors,
        });
        return;
    }
    if (result.didResolve !== true) return;

    const participantCursorsMessage = result.participantCursorsMessage ?? [];
    const participantCursorsPending = result.participantCursorsPending ?? result.participantCursors;
    await emitPendingResolvedMessage({
        sessionId: params.sessionId,
        message: result.message,
        eventKind: result.didUpdate === true && result.didWrite !== true ? "message-updated" : "new-message",
        readyProjection: result.readyProjection,
        participantCursors: participantCursorsMessage,
        logContext: "failed to emit message update after accepted pending delivery",
    });
    await emitPendingChanged({
        sessionId: params.sessionId,
        changedByAccountId: params.actorUserId,
        pendingCount: result.pendingCount,
        pendingBlockedCount: result.pendingBlockedCount,
        pendingVersion: result.pendingVersion,
        participantCursors: participantCursorsPending,
    });
    await publishPendingMutationBadgeRefresh({
        badgeAttentionChanged: result.badgeAttentionChanged,
        participantCursors: [...participantCursorsMessage, ...participantCursorsPending],
    });
}

/** Runs exactly one current-publisher settlement transaction and publishes its durable result. */
export async function coordinateAcceptedPendingSettlement(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    localId: string;
    trustedPublisherFence: TrustedPendingPublisherFence;
    outcome?: AcceptedPendingSettlementRequestV2["outcome"];
    diagnosticCorrelationId?: string;
    publish?: PublishAcceptedPendingSettlement;
}>): Promise<ResolveAcceptedPendingDeliveryResult> {
    const result = await resolveAcceptedPendingDelivery({
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
        localId: params.localId,
        trustedPublisherFence: params.trustedPublisherFence,
        ...(params.outcome ? { outcome: params.outcome } : {}),
        ...(params.diagnosticCorrelationId ? { diagnosticCorrelationId: params.diagnosticCorrelationId } : {}),
    });
    try {
        await (params.publish ?? publishAcceptedPendingSettlement)({
            actorUserId: params.actorUserId,
            sessionId: params.sessionId,
            result,
        });
    } catch (error) {
        // The transaction and AccountChange cursor are already durable. Publication loss is
        // recovered by normal cursor/snapshot convergence and must never rerun settlement.
        log(
            { module: "accepted-pending-settlement", level: "warn", sessionId: params.sessionId, localId: params.localId },
            "accepted pending settlement committed but publication failed",
            error,
        );
    }
    return result;
}
