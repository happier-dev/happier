import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    eventRouter,
    type ClientConnection,
} from "@/app/events/eventRouter";
import type {
    CloseSessionPublisherResult,
} from "@/app/presence/sessionPublisherPresence";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

type ClosedSessionPublisher = Extract<CloseSessionPublisherResult, { status: "closed" }>;

/** The single post-commit fanout owner for an authoritative publisher close. */
export async function publishSessionPublisherClose(params: Readonly<{
    sessionId: string;
    publisherAccountId: string;
    closed: ClosedSessionPublisher;
    skipSenderConnection?: ClientConnection;
}>): Promise<void> {
    const session = await loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    if (session) await Promise.all(params.closed.participantCursors.map(async ({ accountId, cursor }) => {
        const projection = projectSessionTranscriptPublicationRealtimeProjection(
            {
                active: false,
                activeAt: params.closed.activeAt.getTime(),
                ...(params.closed.projection ?? {}),
                ...(params.closed.turnProjection ?? {}),
            },
            session,
            accountId,
        );
        if (projection.kind === "suppress") return;
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                projection.value,
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            ...(params.skipSenderConnection && accountId === params.publisherAccountId
                ? { skipSenderConnection: params.skipSenderConnection }
                : {}),
        });
    }));
    eventRouter.emitEphemeral({
        userId: params.publisherAccountId,
        payload: buildSessionActivityEphemeral(
            params.sessionId,
            false,
            params.closed.activeAt.getTime(),
            false,
        ),
        recipientFilter: { type: "user-scoped-only" },
    });
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: params.closed.badgeAttentionChanged,
        participantCursors: params.closed.participantCursors,
    });
}
