import {
    parseAutomationRunExecutionRecipeV1,
    type AutomationRunExecutionRecipeV1,
    type AutomationStoredWorkflowDefinitionRecipeV2,
    type AutomationReplyHandoffStateV1,
    type AutomationExecutionDispatchStateV3,
    AutomationRunStateV3Schema,
    AUTOMATION_RUN_TERMINAL_STATES_V3,
    isTerminalAutomationRunStateV3,
    type AutomationRunStateV3,
    type AutomationPluginEventDefinitionTriggerInput,
    type AutomationTriggerCreateRequest,
    type AutomationTriggerDefinitionInput,
    type AutomationRunCause,
    type AutomationSessionLifecycleEvent,
} from '@happier-dev/protocol';
import type { automationRunCauseSelect } from './automationPersistenceSelect';

export type AutomationScheduleKind = 'cron' | 'interval';
export type AutomationTargetType = 'new_session' | 'existing_session' | 'execution_run';
/** The released V2 definition target vocabulary. */
export type AutomationLegacyTargetType = Exclude<
    AutomationTargetType,
    'execution_run'
>;
/** The canonical Run-state vocabulary; the Protocol schema is its one owner. */
export type AutomationRunState = AutomationRunStateV3;
export const AUTOMATION_RUN_STATES = AutomationRunStateV3Schema.options;

/** Narrows the shared physical Run enum to the retained Automation contract. */
export function isAutomationRunState(state: string): state is AutomationRunState {
    return AutomationRunStateV3Schema.safeParse(state).success;
}

/** States whose lifecycle is complete and therefore cannot hold Run capacity. */
export const AUTOMATION_RUN_TERMINAL_STATES = AUTOMATION_RUN_TERMINAL_STATES_V3;

export type AutomationRunTerminalState = typeof AUTOMATION_RUN_TERMINAL_STATES[number];

export function isTerminalAutomationRunState(
    state: AutomationRunState,
): state is AutomationRunTerminalState {
    return isTerminalAutomationRunStateV3(state);
}

export type AutomationTriggerKind = import('@happier-dev/protocol').AutomationTriggerKind;
export type AutomationObservationTransport = 'checkpointedPull' | 'durablePush' | 'socket';
export type AutomationRunCauseKind = AutomationRunCause['kind'];
/** The canonical execution-dispatch vocabulary; the Protocol schema is its one owner. */
export type AutomationExecutionDispatchState = AutomationExecutionDispatchStateV3;

/**
 * The durable Run owner derives the only startable dispatch state from the
 * frozen canonical recipe. Legacy and Session-targeted Runs intentionally
 * retain no execution dispatch state.
 */
export function initialAutomationExecutionDispatchStateForRun(
    executionInputEnvelope: string,
): 'notStarted' | null {
    const parsed = parseAutomationRunExecutionRecipeV1(executionInputEnvelope);
    return parsed.kind === 'available' && parsed.recipe.target.kind === 'executionRun'
        ? 'notStarted'
        : null;
}
export type AutomationRunReplyHandoffState = AutomationReplyHandoffStateV1;

/**
 * The execution-dispatch retry ceiling. One decision: a detached dispatch that
 * repeatedly returns strict pre-creation rejection gets this many attempts
 * before start/settlement terminalizes the Run as retry-exhausted.
 */
export const AUTOMATION_EXECUTION_DISPATCH_MAX_ATTEMPTS = 3;

/** States that no longer retain durable Conversation reply custody. */
export const AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES = [
    'none',
    'accepted',
    'suppressed',
    'blocked',
] as const satisfies readonly AutomationRunReplyHandoffState[];

export type AutomationRunReplyHandoffTerminalState =
    typeof AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES[number];

export function isTerminalAutomationRunReplyHandoffState(
    state: AutomationRunReplyHandoffState,
): state is AutomationRunReplyHandoffTerminalState {
    return AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES.some(
        (terminalState) => terminalState === state,
    );
}

export type AutomationAssignmentInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

export type AutomationScheduleInput = Readonly<{
    kind: 'interval';
    everyMs: number;
    scheduleExpr?: undefined;
    timezone?: string | null;
}> | Readonly<{
    kind: 'cron';
    scheduleExpr: string;
    everyMs?: undefined;
    timezone?: string | null;
}>;

/** Exact released V2 schedule input; manual means no automatic trigger. */
export type AutomationLegacyScheduleInput = AutomationScheduleInput | Readonly<{
    kind: 'manual';
    everyMs?: undefined;
    scheduleExpr?: undefined;
    timezone?: undefined;
}>;

/**
 * Server-trusted evidence that an authenticated legacy HTTP request supplied
 * the one released encrypted outer target shape. This is never projected to
 * clients or accepted directly from a request body.
 */
export type AutomationLegacyTemplateEnvelopeAdmission = Readonly<{
    kind: 'legacy-encrypted-existing-session-v1';
    existingSessionId: string;
}> | Readonly<{
    kind: 'legacy-plain-existing-session-v1';
    existingSessionId: string;
}>;

type AutomationDefinitionInputCommon = Readonly<{
    name: string;
    description?: string | null;
    enabled: boolean;
    assignments?: ReadonlyArray<AutomationAssignmentInput>;
    workflowDefinitionId?: string | null;
    scopeSessionId?: string | null;
}>;

/** Retained release-compatible definition bytes. Current V3 routes never construct this arm. */
export type AutomationLegacyDefinitionInput = AutomationDefinitionInputCommon & Readonly<{
    schedule: AutomationLegacyScheduleInput;
    targetType: AutomationLegacyTargetType;
    templateCiphertext: string;
    legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
    executionRecipe?: never;
}>;

/** One current definition writer: a strict Protocol recipe persisted in templateCiphertext. */
export type AutomationCurrentDefinitionInput = AutomationDefinitionInputCommon & Readonly<{
    automationId: string;
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2;
    triggers: ReadonlyArray<AutomationTriggerCreateRequest>;
    targetType?: never;
    templateCiphertext?: never;
    legacyTemplateEnvelopeAdmission?: never;
}>;

export type AutomationUpsertInput = AutomationLegacyDefinitionInput | AutomationCurrentDefinitionInput;

export type AutomationLegacyUpsertInput = AutomationLegacyDefinitionInput;
export type AutomationCurrentUpsertInput = AutomationCurrentDefinitionInput;

type AutomationPatchCommon = Readonly<{
    name?: string;
    description?: string | null;
    enabled?: boolean;
    assignments?: ReadonlyArray<AutomationAssignmentInput>;
    workflowDefinitionId?: string | null;
    scopeSessionId?: string | null;
}>;

export type AutomationCurrentPatchInput = AutomationPatchCommon & Readonly<{
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2;
    targetType?: never;
    templateCiphertext?: never;
    legacyTemplateEnvelopeAdmission?: never;
}>;

export type AutomationLegacyPatchInput = AutomationPatchCommon & Readonly<{
    schedule?: AutomationLegacyScheduleInput;
    executionRecipe?: never;
    targetType?: AutomationLegacyTargetType;
    templateCiphertext?: string;
    legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
}>;

export type AutomationPatchInput =
    | AutomationCurrentPatchInput
    | AutomationLegacyPatchInput;

/** Keeps release-compatible definition input distinct from the current recipe writer. */
export function isAutomationCurrentUpsertInput(
    input: AutomationUpsertInput,
): input is AutomationCurrentUpsertInput {
    return input.executionRecipe !== undefined;
}

/** Keeps release-compatible patch semantics distinct from the current recipe writer. */
export function isAutomationCurrentPatchInput(
    input: AutomationPatchInput,
): input is AutomationCurrentPatchInput {
    return input.executionRecipe !== undefined;
}

export function isAutomationLegacyTargetType(
    targetType: AutomationTargetType | null,
): targetType is AutomationLegacyTargetType {
    return targetType !== null && targetType !== 'execution_run';
}

export type AutomationListItem = Readonly<{
    id: string;
    accountId: string;
    workflowDefinitionId: string | null;
    scopeSessionId: string | null;
    name: string;
    description: string | null;
    enabled: boolean;
    targetType: AutomationTargetType | null;
    templateCiphertext: string;
    templateVersion: number;
    lastRunAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt?: Date;
    }>;
    triggers: ReadonlyArray<AutomationTriggerItem>;
}>;

export type AutomationTriggerItem = Readonly<{
    id: string;
    automationId: string;
    kind: AutomationTriggerKind;
    enabled: boolean;
    revision: number;
    deletedAt: Date | null;
    scheduleKind: AutomationScheduleKind | null;
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
    nextRunAt: Date | null;
    eventPluginId: string | null;
    eventLocalId: string | null;
    sourceSelectorId: string | null;
    sourceContractVersion: number | null;
    observationTransport: AutomationObservationTransport | null;
    webhookEndpointId: string | null;
    observationStartsAt: Date | null;
    watcherMachineId: string | null;
    watcherMachineInstallationId: string | null;
    watcherPluginId: string | null;
    watcherMaterializationId: string | null;
    /**
     * The trigger's private definition envelope. Present on full definition
     * reads; the list-specific read intentionally never loads it.
     */
    definitionEnvelope?: string | null;
    sessionLifecycleEventsJson: string | null;
    sessionLifecyclePolicyKind: 'currentTurn' | 'firstMatch' | 'nextMatches' | 'everyMatch' | null;
    sessionLifecycleMatchCount: number | null;
    remainingOccurrences: number | null;
    sourceSessionId: string | null;
    sourceTurnId: string | null;
    sourceRunId?: string | null;
    sourceRunMachineId?: string | null;
    runLifecycleConfigurationJson?: string | null;
    createdAt: Date;
    updatedAt: Date;
    /**
     * Retained trigger-side status relation. No current reader projects it —
     * batched status summaries come from the status projection owner — so no
     * select loads it.
     */
    eventSourceStatus?: unknown | null;
}>;

export type AutomationRunItem = Readonly<{
    id: string;
    originKind: 'automation';
    automationId: string;
    /** Scoped Workflow context does not change the Run's Automation cause. */
    originSessionId: string | null;
    accountId: string;
    state: AutomationRunState;
    triggerId: string | null;
    /** Exact current trigger absence, batch-derived by the Run read owner. */
    triggerRetired?: boolean;
    causeKind: AutomationRunCauseKind;
    causeTriggerKind: AutomationTriggerKind | null;
    causeTriggerRevision: number | null;
    causeOccurredAt: Date | null;
    causeEventPluginId: string | null;
    causeEventLocalId: string | null;
    causeScheduledFor: Date | null;
    causeSessionLifecycleEvent: AutomationSessionLifecycleEvent | null;
    causeSourceSessionId: string | null;
    causeSourceTurnId: string | null;
    causeRunLifecycleEvidenceJson: string | null;
    causeSessionLifecycleRequestId: string | null;
    causeSessionLifecycleRequestKind: 'permission' | 'user_action' | null;
    causeSessionLifecyclePolicyKind: 'currentTurn' | 'firstMatch' | 'nextMatches' | 'everyMatch' | null;
    causeSessionLifecycleConfiguredCount: number | null;
    occurrenceKey: string | null;
    legacyManualIdempotencyKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    causeSourceSelectorId: string | null;
    triggerEvidenceEnvelope: string | null;
    executionInputEnvelope: string | null;
    workflowCustodyState?: 'pending' | 'settled' | null;
    executionDispatchState: AutomationExecutionDispatchState | null;
    executionAttempt: number;
    executionDispatchCommittedAt: Date | null;
    executionDispatchDueAt: Date | null;
    executionNativeRunId: string | null;
    executionNativeCallId: string | null;
    executionNativeSidechainId: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffActionPluginId: string | null;
    replyHandoffActionLocalId: string | null;
    replyHandoffTargetMachineId: string | null;
    replyHandoffTargetMachineInstallationId: string | null;
    replyHandoffTargetMaterializationId: string | null;
    replyHandoffId: string | null;
    replyHandoffState: AutomationRunReplyHandoffState;
    replyHandoffAttempt: number;
    replyHandoffDueAt: Date | null;
    scheduledAt: Date;
    dueAt: Date;
    claimedAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    claimedByMachineId: string | null;
    leaseExpiresAt: Date | null;
    attempt: number;
    revision: number;
    summaryCiphertext: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    producedSessionId: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

/** The authenticated current-version Run-list row. */
export type AutomationRunV3ListItem =
    Pick<
        AutomationRunItem,
        | keyof typeof automationRunCauseSelect
        | 'id'
        | 'automationId'
        | 'state'
        | 'executionDispatchState'
        | 'executionAttempt'
        | 'errorCode'
        | 'replyHandoffState'
        | 'replyHandoffAttempt'
        | 'replyHandoffDueAt'
        | 'dueAt'
        | 'claimedAt'
        | 'startedAt'
        | 'finishedAt'
        | 'claimedByMachineId'
        | 'leaseExpiresAt'
        | 'attempt'
        | 'revision'
        | 'producedSessionId'
        | 'createdAt'
        | 'updatedAt'
    > & Readonly<{ triggerRetired?: boolean }>;


/** One committed Run transition as persisted by the lifecycle owners. */
export type AutomationRunEventRow = Readonly<{
    ts: Date;
    type: string;
    payload: unknown;
}>;

/**
 * The authenticated detail read adds the Run's committed transition history to
 * the canonical Run row. Newest-first as selected; the detail projection is the
 * owner that presents it in ascending order.
 */
export type AutomationRunDetailItem = AutomationRunItem & Readonly<{
    events: readonly AutomationRunEventRow[];
}>;

export type AutomationRunWithAutomation = AutomationRunItem & Readonly<{
    assignments: ReadonlyArray<{ machineId: string; priority: number }>;
    automation: {
        id: string;
        name: string;
        enabled: boolean;
        targetType: AutomationTargetType | null;
        templateCiphertext: string;
    };
}>;
