import type { Tx } from "@/storage/inTx";

export const AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS = [
    "fail",
    "cancel",
    "end_session",
] as const;

/** Reads canonical Session settlement history for the exact one-off condition. */
export async function hasAppliedSessionLifecycleTerminalNoRunReceiptTx(params: Readonly<{
    tx: Tx;
    sourceSessionId: string;
    sourceTurnId: string;
}>): Promise<boolean> {
    const receipt = await params.tx.sessionTurnMutationReceipt.findFirst({
        where: {
            sessionId: params.sourceSessionId,
            turnId: params.sourceTurnId,
            action: { in: [...AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS] },
            decision: "applied",
        },
        select: { id: true },
    });
    return receipt !== null;
}
