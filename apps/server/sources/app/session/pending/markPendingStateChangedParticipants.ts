import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";

export async function markPendingStateChangedParticipants(params: {
    tx: Tx;
    sessionId: string;
    pendingVersion: number;
    pendingCount: number;
}): Promise<SessionParticipantCursor[]> {
    return await markSessionParticipantsChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        hint: { pendingVersion: params.pendingVersion, pendingCount: params.pendingCount },
    });
}
