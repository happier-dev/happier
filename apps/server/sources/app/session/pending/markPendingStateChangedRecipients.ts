import { markSessionProjectionRecipientsChanged, type SessionRecipientPublication } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import type { Tx } from "@/storage/inTx";
import { buildPendingActivationRequestHint } from "@/app/session/pending/publishPendingMutation";

export async function markPendingStateChangedRecipients(params: {
    tx: Tx;
    sessionId: string;
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount?: number;
    meaningfulActivityAt?: Date;
    activationTarget?: Readonly<{ accountId: string; requestId: string }>;
}): Promise<SessionRecipientPublication[]> {
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
    return await markSessionProjectionRecipientsChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        // Queue bookkeeping is not a committed source occurrence. Promotion
        // into an original message publishes through its own writer.
        followSourceChanged: false,
        usageAccountingChanged: false,
        hint,
        ...(params.activationTarget
            ? {
                hintForRecipient: (accountId: string) => accountId === params.activationTarget!.accountId
                    ? { ...hint, ...buildPendingActivationRequestHint(params.activationTarget) }
                    : hint,
            }
            : {}),
    });
}
