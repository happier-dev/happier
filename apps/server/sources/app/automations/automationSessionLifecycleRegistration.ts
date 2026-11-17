import type { AutomationSessionLifecycleRegistrationErrorCode, AutomationSessionLifecycleStructuralTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';

import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

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

export type ValidatedSessionLifecycleTriggerRegistration = AutomationSessionLifecycleStructuralTrigger;

/** Server-private context supplied only by the canonical Session row birth writer. */
export type AutomationSessionBirthContext = Readonly<{
    id: string;
    accountId: string;
    createdAt: Date;
}>;

/** Exact Session selection can prove target inequality; broad scopes use cause-chain exclusion. */
export function validateSessionLifecycleExecutionTargetInequality(params: Readonly<{
    automationTargetType: "new_session" | "existing_session" | "execution_run" | null;
    automationExistingSessionId?: string | null;
    serverIdentityId: string | null;
    input: AutomationSessionLifecycleStructuralTrigger;
}>): void {
    if (params.automationTargetType !== "existing_session" || params.input.subjectKind !== 'session') return;
    const targetSessionId = params.automationExistingSessionId?.trim();
    if (!targetSessionId || !params.serverIdentityId) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "executionTargetInequalityUnproven",
            "Existing-Session Automation target cannot prove it differs from the lifecycle source",
        );
    }
    if (params.input.subjectKey === automationSubjectKeyV1({
        kind: 'session', serverId: params.serverIdentityId, sessionId: targetSessionId,
    })) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            "sourceMatchesExecutionTarget",
            "Session lifecycle source Session must differ from the Automation execution target",
        );
    }
}

/** Exact-turn registration consumes a local digest witness; future scopes need no source census. */
export async function validateSessionLifecycleTriggerRegistrationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationTargetType: "new_session" | "existing_session" | "execution_run" | null;
    automationExistingSessionId?: string | null;
    serverIdentityId: string | null;
    input: AutomationSessionLifecycleStructuralTrigger & Readonly<{ enabled: boolean }>;
    newbornSession?: AutomationSessionBirthContext;
}>): Promise<ValidatedSessionLifecycleTriggerRegistration> {
    const { enabled: _enabled, ...definition } = params.input;
    validateSessionLifecycleExecutionTargetInequality(params);
    if (definition.events.includes('sessionStarted') && definition.subjectKind === 'session') {
        const birth = params.newbornSession;
        if (!birth || birth.accountId !== params.accountId || !params.serverIdentityId
            || definition.subjectKey !== automationSubjectKeyV1({
                kind: 'session', serverId: params.serverIdentityId, sessionId: birth.id,
            })) {
            throw new AutomationSessionLifecycleRegistrationValidationError(
                'session_already_started', 'Session-start triggers require the Session creation transaction',
            );
        }
    }
    if (definition.policy.kind !== 'currentTurn') return definition;
    const sourceSessionId = definition.sourceSessionId;
    if (definition.subjectKind !== 'session' || !sourceSessionId || !params.serverIdentityId
        || definition.subjectKey !== automationSubjectKeyV1({
            kind: 'session', serverId: params.serverIdentityId, sessionId: sourceSessionId,
        })) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            'session_trigger_current_turn_requires_session', 'Current-turn policy requires an exact local Session',
        );
    }
    const sourceSession = await params.tx.session.findFirst({
        where: { id: sourceSessionId, accountId: params.accountId },
        select: { latestTurnId: true },
    });
    if (!sourceSession) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            'sourceSessionUnavailable', 'Session lifecycle source Session is unavailable',
        );
    }
    const sourceTurnId = definition.policy.sourceTurnId;
    if (sourceSession.latestTurnId !== sourceTurnId) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            'sourceTurnNotCurrent', 'Session lifecycle source turn is not the current latest turn',
        );
    }
    const sourceTurn = await params.tx.sessionTurn.findUnique({
        where: { sessionId_turnId: { sessionId: sourceSessionId, turnId: sourceTurnId } },
        select: { status: true },
    });
    if (!sourceTurn) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            'sourceTurnUnavailable', 'Session lifecycle source turn is unavailable',
        );
    }
    if (sourceTurn.status !== 'in_progress' || await hasAppliedSessionLifecycleTerminalNoRunReceiptTx({
        tx: params.tx, sourceSessionId, sourceTurnId,
    })) {
        throw new AutomationSessionLifecycleRegistrationValidationError(
            'sourceTurnNotInProgress', 'Session lifecycle source turn is no longer eligible for completion admission',
        );
    }
    return definition;
}
