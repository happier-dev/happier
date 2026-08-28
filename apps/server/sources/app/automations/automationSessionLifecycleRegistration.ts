import type {
    AutomationSessionLifecycleRegistrationErrorCode,
    AutomationSessionLifecycleTriggerInput,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { hasAppliedSessionLifecycleTerminalNoRunReceiptTx } from "./automationSessionLifecycleTerminalTruth";
import { AutomationValidationError } from "./automationValidation";

export class AutomationSessionLifecycleRegistrationValidationError
    extends AutomationValidationError {
    readonly code: AutomationSessionLifecycleRegistrationErrorCode;

    constructor(code: AutomationSessionLifecycleRegistrationErrorCode, message: string) {
        super(message);
        this.name = "AutomationSessionLifecycleRegistrationValidationError";
        this.code = code;
    }
}

export type ValidatedSessionLifecycleTriggerRegistration = Readonly<{
    sessionLifecycleEvent: "parentTurnCompleted";
    sourceSessionId: string;
    sourceTurnId: string;
}>;

export function validateSessionLifecycleExecutionTargetInequality(params: Readonly<{
    automationTargetType: "new_session" | "existing_session" | "execution_run";
    automationExistingSessionId?: string | null;
    sourceSessionId: string;
}>): void {
    if (params.automationTargetType !== "existing_session") return;
    const targetSessionId = params.automationExistingSessionId?.trim();
    if (!targetSessionId) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "executionTargetInequalityUnproven",
            "Existing-Session Automation target cannot prove it differs from the lifecycle source",
        );
    }
    if (targetSessionId === params.sourceSessionId) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceMatchesExecutionTarget",
            "Session lifecycle source Session must differ from the Automation execution target",
        );
    }
}

/** Exact same-Account/current/in-progress registration witness. */
export async function validateSessionLifecycleTriggerRegistrationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationTargetType: "new_session" | "existing_session" | "execution_run";
    automationExistingSessionId?: string | null;
    input: AutomationSessionLifecycleTriggerInput;
}>): Promise<ValidatedSessionLifecycleTriggerRegistration> {
    const sourceSessionId = params.input.scope.sourceSessionId;
    const sourceTurnId = params.input.scope.sourceTurnId;
    const sourceSession = await params.tx.session.findFirst({
        where: { id: sourceSessionId, accountId: params.accountId },
        select: { latestTurnId: true },
    });
    if (!sourceSession) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceSessionUnavailable",
            "Session lifecycle source Session is unavailable",
        );
    }
    if (sourceSession.latestTurnId !== sourceTurnId) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceTurnNotCurrent",
            "Session lifecycle source turn is not the current latest turn",
        );
    }
    const sourceTurn = await params.tx.sessionTurn.findUnique({
        where: { sessionId_turnId: { sessionId: sourceSessionId, turnId: sourceTurnId } },
        select: { status: true },
    });
    if (!sourceTurn) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceTurnUnavailable",
            "Session lifecycle source turn is unavailable",
        );
    }
    if (
        sourceTurn.status !== "in_progress"
        || await hasAppliedSessionLifecycleTerminalNoRunReceiptTx({
            tx: params.tx,
            sourceSessionId,
            sourceTurnId,
        })
    ) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceTurnNotInProgress",
            "Session lifecycle source turn is no longer eligible for completion admission",
        );
    }
    validateSessionLifecycleExecutionTargetInequality({
        automationTargetType: params.automationTargetType,
        automationExistingSessionId: params.automationExistingSessionId,
        sourceSessionId,
    });
    return {
        sessionLifecycleEvent: params.input.event,
        sourceSessionId,
        sourceTurnId,
    };
}
