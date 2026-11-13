import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { publishSessionAfterCommit } from "@/app/session/publishSessionAfterCommit";
import type {
    ApplySessionTurnMutationResult,
} from "@/app/session/sessionWriteService";

export function resolveSessionTurnUpdateSkipSenderConnection(connection?: ClientConnection): ClientConnection | undefined {
    if (!connection) return undefined;
    return connection.connectionType === "user-scoped" ? undefined : connection;
}

export async function publishSessionTurnMutationUpdate(params: {
    sessionId: string;
    actorUserId: string;
    connection?: ClientConnection;
    result: Extract<ApplySessionTurnMutationResult, { ok: true }>;
}): Promise<void> {
    if (!params.result.didApply) return;
    const skipSenderConnection = resolveSessionTurnUpdateSkipSenderConnection(params.connection);
    const session = await loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    if (session) {
        await Promise.all(params.result.recipientCursors.map(async ({ accountId, cursor }) => {
            const projection = projectSessionTranscriptPublicationRealtimeProjection(
                {
                    latestTurnId: params.result.latestTurnId,
                    latestTurnStatus: params.result.latestTurnStatus,
                    latestTurnStatusObservedAt: params.result.latestTurnStatusObservedAt,
                    lastRuntimeIssue: params.result.lastRuntimeIssue,
                    ...('rollbackEligibleTurnStarts' in params.result
                        && params.result.rollbackEligibleTurnStarts !== undefined
                        ? { rollbackEligibleTurnStarts: params.result.rollbackEligibleTurnStarts }
                        : {}),
                },
                session,
                accountId,
            );
            if (projection.kind === "suppress") return;
            const payload = buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                projection.value,
            );
            await eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
                skipSenderConnection: accountId === params.actorUserId ? skipSenderConnection : undefined,
            });
        }));
    }
    await refreshTrackedSessionAccountBadgePushes({
        badgeAttentionChanged: params.result.badgeAttentionChanged,
        sessionId: params.sessionId,
    });
}

/**
 * A committed turn mutation's fan-out, for every transport: the caller acknowledges on commit
 * (the runner's turn end and the next send wait on that ack) and this runs after the Session's
 * earlier fan-out. One phase line per mutation splits commit time from fan-out time.
 */
export function publishSessionTurnMutationAfterCommit(params: Parameters<typeof publishSessionTurnMutationUpdate>[0] & Readonly<{
    action: string;
    applyStartedAtMs: number;
    committedAtMs: number;
}>): Promise<void> {
    const { action, applyStartedAtMs, committedAtMs, ...publication } = params;
    return publishSessionAfterCommit(params.sessionId, "Session turn mutation", async () => {
        const publishStartedAt = Date.now();
        await publishSessionTurnMutationUpdate(publication);
        log({ module: "session-turns", level: "info", event: "session-turn-mutation-phases",
            sessionId: params.sessionId, action, applied: params.result.didApply,
            commitMs: committedAtMs - applyStartedAtMs, publishQueuedMs: publishStartedAt - committedAtMs,
            publishMs: Date.now() - publishStartedAt }, "Session turn mutation committed and published");
    });
}
