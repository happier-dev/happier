import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";

export async function markPendingStateChangedParticipants(params: {
    tx: Tx;
    sessionId: string;
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount?: number;
    meaningfulActivityAt?: Date;
    activationTarget?: Readonly<{ accountId: string; requestId: string }>;
}): Promise<SessionParticipantCursor[]> {
    const meaningfulActivityAt = params.meaningfulActivityAt instanceof Date
        && Number.isFinite(params.meaningfulActivityAt.getTime())
        ? params.meaningfulActivityAt.getTime()
        : undefined;
    const hint = {
        pendingVersion: params.pendingVersion,
        pendingCount: params.pendingCount,
        ...(typeof params.pendingBlockedCount === "number" ? { pendingBlockedCount: params.pendingBlockedCount } : {}),
        ...(typeof meaningfulActivityAt === "number" ? { meaningfulActivityAt } : {}),
    };
    return await markSessionParticipantsChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        hint,
        ...(params.activationTarget
            ? {
                hintForParticipant: (accountId: string) => accountId === params.activationTarget!.accountId
                    ? { ...hint, pendingActivationRequestId: params.activationTarget!.requestId }
                    : hint,
            }
            : {}),
    });
}
