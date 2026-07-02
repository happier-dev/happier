import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { SessionReadyProjectionUpdate } from "@/app/session/sessionWriteService";
import { inTx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

export async function publishSessionReadyProjectionUpdate(params: Readonly<{
    sessionId: string;
    readyProjection?: SessionReadyProjectionUpdate;
    skipSenderAccountId?: string;
    skipSenderConnection?: ClientConnection;
}>): Promise<SessionParticipantCursor[]> {
    const readyProjection = params.readyProjection;
    if (!readyProjection) return [];

    const participantCursors = await inTx(async (tx) => await markSessionParticipantsChanged({
        tx,
        sessionId: params.sessionId,
        hint: {
            latestReadyEventSeq: readyProjection.latestReadyEventSeq,
            latestReadyEventAt: readyProjection.latestReadyEventAt,
        },
    }));

    await Promise.all(participantCursors.map(async ({ accountId, cursor }) => {
        const payload = buildUpdateSessionUpdate(
            params.sessionId,
            cursor,
            randomKeyNaked(12),
            undefined,
            undefined,
            {
                latestReadyEventSeq: readyProjection.latestReadyEventSeq,
                latestReadyEventAt: readyProjection.latestReadyEventAt,
            },
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

    return participantCursors;
}
