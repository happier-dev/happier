import {
    parseAutomationRunExecutionRecipeV1,
    type AutomationRunExecutionRecipeV1,
    type AutomationRunStateV3,
    type AutomationV3PluginEventDefinitionTriggerInput,
} from '@happier-dev/protocol';

export type AutomationScheduleKind = 'cron' | 'interval';
export type AutomationTargetType = 'new_session' | 'existing_session' | 'execution_run';
/** The released V2 definition target vocabulary. */
export type AutomationLegacyTargetType = Exclude<
    AutomationTargetType,
    'execution_run'
>;
/** The canonical Run-state vocabulary; the Protocol schema is its one owner. */
export type AutomationRunState = AutomationRunStateV3;

/** States whose lifecycle is complete and therefore cannot hold Run capacity. */
export const AUTOMATION_RUN_TERMINAL_STATES = [
    'succeeded',
    'failed',
    'cancelled',
    'expired',
    'dispatch_failed',
    'skipped',
    'missed',
    'outcome_uncertain',
] as const satisfies readonly AutomationRunState[];

export type AutomationRunTerminalState = typeof AUTOMATION_RUN_TERMINAL_STATES[number];

export function isTerminalAutomationRunState(
    state: AutomationRunState,
): state is AutomationRunTerminalState {
    return AUTOMATION_RUN_TERMINAL_STATES.some((terminalState) => terminalState === state);
}

export type AutomationTriggerKind = 'schedule' | 'manual' | 'pluginEvent' | 'conversation';
export type AutomationObservationTransport = 'checkpointedPull' | 'durablePush';
export type AutomationRunOriginKind = 'scheduled' | 'manual' | 'pluginEvent' | 'conversation';
export type AutomationExecutionDispatchState =
    | 'notStarted'
    | 'dispatchPermitted'
    | 'retryWaiting'
    | 'started'
    | 'settled'
    | 'outcomeUnknown';

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
export type AutomationRunReplyHandoffState =
    | 'none'
    | 'awaitingResult'
    | 'ready'
    | 'handingOff'
    | 'accepted'
    | 'suppressed'
    | 'blocked';

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
}>;

type AutomationDefinitionTriggerInput =
    | Readonly<{
        schedule: AutomationScheduleInput;
        pluginEvent?: never;
        manual?: never;
    }>
    | Readonly<{
        schedule?: never;
        pluginEvent: AutomationV3PluginEventDefinitionTriggerInput;
        manual?: never;
    }>
    | Readonly<{
        schedule?: never;
        pluginEvent?: never;
        manual: true;
    }>;

/** Retained release-compatible definition bytes. Current V3 routes never construct this arm. */
export type AutomationLegacyDefinitionInput = Readonly<{
    targetType: AutomationLegacyTargetType;
    templateCiphertext: string;
    legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission;
    executionRecipe?: never;
}>;

/** One current definition writer: a strict Protocol recipe persisted in templateCiphertext. */
export type AutomationCurrentDefinitionInput = Readonly<{
    executionRecipe: AutomationRunExecutionRecipeV1;
    targetType?: never;
    templateCiphertext?: never;
    legacyTemplateEnvelopeAdmission?: never;
}>;

export type AutomationUpsertInput = AutomationDefinitionInputCommon
    & AutomationDefinitionTriggerInput & (
    | AutomationLegacyDefinitionInput
    | AutomationCurrentDefinitionInput
);

export type AutomationLegacyUpsertInput =
    AutomationDefinitionInputCommon
    & Extract<AutomationDefinitionTriggerInput, { schedule: AutomationScheduleInput }>
    & AutomationLegacyDefinitionInput;
export type AutomationCurrentUpsertInput =
    AutomationDefinitionInputCommon
    & AutomationDefinitionTriggerInput
    & AutomationCurrentDefinitionInput;

type AutomationPatchCommon = Readonly<{
    name?: string;
    description?: string | null;
    enabled?: boolean;
    schedule?: AutomationScheduleInput;
    pluginEvent?: AutomationV3PluginEventDefinitionTriggerInput;
    manual?: true;
    assignments?: ReadonlyArray<AutomationAssignmentInput>;
}>;

export type AutomationCurrentPatchInput = AutomationPatchCommon & Readonly<{
    executionRecipe: AutomationRunExecutionRecipeV1;
    targetType?: never;
    templateCiphertext?: never;
    legacyTemplateEnvelopeAdmission?: never;
}>;

export type AutomationLegacyPatchInput = AutomationPatchCommon & Readonly<{
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
    targetType: AutomationTargetType,
): targetType is AutomationLegacyTargetType {
    return targetType !== 'execution_run';
}

export type AutomationListItem = Readonly<{
    id: string;
    accountId: string;
    name: string;
    description: string | null;
    enabled: boolean;
    triggerKind: AutomationTriggerKind;
    scheduleKind: AutomationScheduleKind | null;
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
    targetType: AutomationTargetType;
    templateCiphertext: string;
    templateVersion: number;
    triggerEventPluginId: string | null;
    triggerEventLocalId: string | null;
    triggerSourceSelectorId: string | null;
    triggerSourceContractVersion: number | null;
    triggerObservationTransport: AutomationObservationTransport | null;
    triggerWebhookEndpointId: string | null;
    triggerObservationStartsAt: Date | null;
    watcherMachineId: string | null;
    watcherMachineInstallationId: string | null;
    watcherPluginId: string | null;
    watcherMaterializationId: string | null;
    triggerDefinitionEnvelope: string | null;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    assignments: ReadonlyArray<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt?: Date;
    }>;
}>;

export type AutomationRunItem = Readonly<{
    id: string;
    automationId: string;
    accountId: string;
    state: AutomationRunState;
    originKind: AutomationRunOriginKind;
    originOccurredAt: Date | null;
    occurrenceKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    originSourceSelectorId: string | null;
    triggerEvidenceEnvelope: string | null;
    executionInputEnvelope: string | null;
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
    replyHandoffReceiptEnvelope: string | null;
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

export type AutomationRunWithAutomation = AutomationRunItem & Readonly<{
    automation: {
        id: string;
        name: string;
        enabled: boolean;
        triggerKind: AutomationTriggerKind;
        targetType: AutomationTargetType;
        templateCiphertext: string;
    };
}>;
