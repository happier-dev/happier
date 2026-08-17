import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type {
    ApplySessionTurnMutationResult,
    ReassertSessionLatestTurnStatusResult,
} from "@/app/session/sessionWriteService";

function resolveSessionTurnUpdateSkipSenderConnection(connection?: ClientConnection): ClientConnection | undefined {
    if (!connection) return undefined;
    return connection.connectionType === "user-scoped" ? undefined : connection;
}

export async function publishSessionTurnMutationUpdate(params: {
    sessionId: string;
    actorUserId: string;
    connection?: ClientConnection;
    result:
        | Extract<ApplySessionTurnMutationResult, { ok: true }>
        | Extract<ReassertSessionLatestTurnStatusResult, { ok: true }>;
}): Promise<void> {
    if (!params.result.didApply) return;
    const skipSenderConnection = resolveSessionTurnUpdateSkipSenderConnection(params.connection);
    const session = await loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    if (session) {
        await Promise.all(params.result.participantCursors.map(async ({ accountId, cursor }) => {
            const projection = projectSessionTranscriptPublicationRealtimeProjection(
                {
                    latestTurnId: params.result.latestTurnId,
                    latestTurnStatus: params.result.latestTurnStatus,
                    latestTurnStatusObservedAt: params.result.latestTurnStatusObservedAt,
                    lastRuntimeIssue: params.result.lastRuntimeIssue,
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
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
                skipSenderConnection: accountId === params.actorUserId ? skipSenderConnection : undefined,
            });
        }));
    }
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: params.result.badgeAttentionChanged,
        participantCursors: params.result.participantCursors,
    });
}
