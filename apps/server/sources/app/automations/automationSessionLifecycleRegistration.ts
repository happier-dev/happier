import type {
    AutomationSessionLifecycleRegistrationErrorCode,
    AutomationSessionLifecycleTrigger,
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

export type ValidatedSessionLifecycleTriggerRegistration = AutomationSessionLifecycleTrigger;

/** Server-private context supplied only by the canonical Session row birth writer. */
export type AutomationSessionBirthContext = Readonly<{
    id: string;
    accountId: string;
    createdAt: Date;
}>;

export function validateSessionLifecycleExecutionTargetInequality(params: Readonly<{
    automationTargetType: "new_session" | "existing_session" | "execution_run" | null;
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

/** Same-Account source witness, plus exact current-turn eligibility where selected. */
export async function validateSessionLifecycleTriggerRegistrationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationTargetType: "new_session" | "existing_session" | "execution_run" | null;
    automationExistingSessionId?: string | null;
    input: AutomationSessionLifecycleTriggerInput;
    newbornSession?: AutomationSessionBirthContext;
}>): Promise<ValidatedSessionLifecycleTriggerRegistration> {
    const onSessionStart = params.input.events.includes("sessionStarted");
    // Ordinary CRUD cannot register a missed creation occurrence. Only the
    // row returned by Session birth supplies this private transaction context.
    if (onSessionStart && (!params.newbornSession
        || params.newbornSession.id !== params.input.sourceSessionId
        || params.newbornSession.accountId !== params.accountId)) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "session_already_started", "Session-start triggers require the Session creation transaction",
        );
    }
    const sourceSessionId = params.input.sourceSessionId;
    const sourceSession = await params.tx.session.findFirst({
        where: { id: sourceSessionId, accountId: params.accountId },
        select: { latestTurnId: true, createdAt: true },
    });
    if (!sourceSession) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceSessionUnavailable",
            "Session lifecycle source Session is unavailable",
        );
    }
    if (onSessionStart && sourceSession.createdAt.getTime() !== params.newbornSession!.createdAt.getTime()) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "session_already_started", "Session-start registration does not match the newborn Session",
        );
    }
    validateSessionLifecycleExecutionTargetInequality({
        automationTargetType: params.automationTargetType,
        automationExistingSessionId: params.automationExistingSessionId,
        sourceSessionId,
    });
    if (params.input.policy.kind !== "currentTurn") {
        return {
            kind: "sessionLifecycle",
            sourceSessionId,
            events: params.input.events,
            policy: params.input.policy,
        };
    }
    const sourceTurnId = params.input.policy.sourceTurnId;
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
    return {
        kind: "sessionLifecycle",
        sourceSessionId,
        events: params.input.events,
        policy: params.input.policy,
    };
}
