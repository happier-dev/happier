import type { Tx } from "@/storage/inTx";

export const AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS = [
    "fail",
    "cancel",
    "end_session",
] as const;

/**
 * Every canonical Session-turn mutation action whose settlement can produce a
 * lifecycle occurrence and therefore an Automation Run insert. The occurrence
 * uniqueness constraint is the admission concurrency owner, so each of these
 * settlements must be able to restart and rejoin instead of failing the turn.
 */
const AUTOMATION_SESSION_LIFECYCLE_OCCURRENCE_ACTIONS: readonly string[] = [
    "begin",
    "complete",
    ...AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS,
];

export function producesAutomationSessionLifecycleOccurrence(action: string): boolean {
    return AUTOMATION_SESSION_LIFECYCLE_OCCURRENCE_ACTIONS.includes(action);
}

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
