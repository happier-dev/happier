import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { inTx } from "@/storage/inTx";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";

export type TimeoutPublisherResult =
    | { status: "expired"; sessionId: string; activeAt: Date; participantCursors: readonly SessionParticipantCursor[]; activationHint?: Readonly<{ accountId: string; requestId: string; pendingCount: number; pendingBlockedCount: number; pendingVersion: number }> }
    | { status: "stale"; sessionId: string };

/** Expires only exact scanned reachability fences; Runtime Activity is deliberately not imported. */
export async function expireSessionPublisherCandidates(params: Readonly<{
    candidates: readonly Readonly<{ sessionId: string; observedFence: Date }>[];
    observedBefore: Date;
}>): Promise<TimeoutPublisherResult[]> {
    const results: TimeoutPublisherResult[] = [];
    for (const candidate of params.candidates) {
        results.push(await inTx(async (tx): Promise<TimeoutPublisherResult> => {
            const updated = await tx.session.updateMany({
                where: {
                    id: candidate.sessionId,
                    active: true,
                    archivedAt: null,
                    lastActiveAt: candidate.observedFence,
                    AND: { lastActiveAt: { lte: params.observedBefore } },
                },
                data: { active: false },
            });
            if (updated.count === 0) return { status: "stale", sessionId: candidate.sessionId };
            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: candidate.sessionId });
            const session = await tx.session.findUniqueOrThrow({
                where: { id: candidate.sessionId },
                select: {
                    accountId: true,
                    lastActiveAt: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    pendingActivationRequestId: true,
                    pendingActivationRequestedAt: true,
                    pendingActivationStatus: true,
                    pendingActivationFailureCode: true,
                },
            });
            const authorization = mapPendingActivationAuthorization(session);
            return {
                status: "expired",
                sessionId: candidate.sessionId,
                activeAt: candidate.observedFence,
                participantCursors,
                ...(authorization?.status === 'waiting' ? {
                    activationHint: {
                        accountId: session.accountId,
                        requestId: authorization.requestId,
                        pendingCount: session.pendingCount,
                        pendingBlockedCount: session.pendingBlockedCount,
                        pendingVersion: session.pendingVersion,
                    },
                } : {}),
            };
        }));
    }
    return results;
}
