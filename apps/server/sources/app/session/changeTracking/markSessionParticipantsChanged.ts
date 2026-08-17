import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import {
    loadSessionTranscriptPublication,
    projectSessionTranscriptPublicationChangeHint,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import type { Tx } from "@/storage/inTx";

export type SessionParticipantCursor = { accountId: string; cursor: number };

export async function markSessionParticipantsChanged(params: {
    tx: Tx;
    sessionId: string;
    hint?: unknown;
    participantUserIds?: readonly string[];
    hintForParticipant?: (accountId: string) => unknown;
}): Promise<SessionParticipantCursor[]> {
    const publication = await loadSessionTranscriptPublication(params.tx, params.sessionId);
    const participantUserIds = params.participantUserIds ?? await getSessionParticipantUserIds({
        sessionId: params.sessionId,
        tx: params.tx,
    });
    const participantCursors: SessionParticipantCursor[] = [];

    for (const participantUserId of participantUserIds) {
        const hint = projectSessionTranscriptPublicationChangeHint(
            params.hintForParticipant
                ? params.hintForParticipant(participantUserId)
                : params.hint,
            publication,
            participantUserId,
        );
        if (hint.kind === "suppress") continue;
        const cursor = await markAccountChanged(params.tx, {
            accountId: participantUserId,
            kind: "session",
            entityId: params.sessionId,
            hint: hint.value,
        });
        participantCursors.push({ accountId: participantUserId, cursor });
    }

    return participantCursors;
}
