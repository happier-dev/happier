import {
    buildUpdateSessionUpdate,
    eventRouter,
    type ClientConnection,
} from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";

export async function publishSessionReadCursorUpdate(params: Readonly<{
    sessionId: string;
    lastViewedSessionSeq: number | null;
    participantCursors: SessionParticipantCursor[];
    badgeAttentionChanged: boolean;
    skipSenderConnection?: ClientConnection;
    skipSenderAccountId?: string;
}>): Promise<void> {
    const lastViewedSessionSeq = params.lastViewedSessionSeq;
    if (typeof lastViewedSessionSeq === "number") {
        await Promise.all(params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildUpdateSessionUpdate(
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                { lastViewedSessionSeq },
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
                ...(params.skipSenderConnection && accountId === params.skipSenderAccountId
                    ? { skipSenderConnection: params.skipSenderConnection }
                    : {}),
            });
        }));
    }

    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: params.badgeAttentionChanged,
        participantCursors: params.participantCursors,
    });
}
