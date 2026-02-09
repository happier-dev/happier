import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import type { Tx } from "@/storage/inTx";

export type SessionParticipantCursor = { accountId: string; cursor: number };

export async function markSessionParticipantsChanged(params: {
    tx: Tx;
    sessionId: string;
    hint?: unknown;
}): Promise<SessionParticipantCursor[]> {
    const participantUserIds = await getSessionParticipantUserIds({
        sessionId: params.sessionId,
        tx: params.tx,
    });
    const participantCursors: SessionParticipantCursor[] = [];

    for (const participantUserId of participantUserIds) {
        const cursor = await markAccountChanged(params.tx, {
            accountId: participantUserId,
            kind: "session",
            entityId: params.sessionId,
            hint: params.hint,
        });
        participantCursors.push({ accountId: participantUserId, cursor });
    }

    return participantCursors;
}
