import { useUnistyles } from 'react-native-unistyles';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type {
    WorkflowInvocationRecoveryV1,
    WorkflowProgressEnvelopeV1,
    WorkflowInvocationLifecycleV1,
} from '@happier-dev/protocol';

import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import type {
    ExecutionRunPromptResponse,
    ExecutionRunPromptResponseTarget,
} from '@/components/tools/shell/permissions/executionRunPromptResponseTarget';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { workStatusSurfaceStyle } from '@/components/work/status/workStatusTreatment';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { MultiTextInput } from '@/components/ui/forms/MultiTextInput';

import { describeWorkflowInvocationAttempt } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { formatWorkflowUsageLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import { WorkflowResultContractSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { TechnicalDetailsDisclosure, type TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { WorkflowReviewValue } from './WorkflowReviewCard';
import { useAnsweredByLabel } from './workflowAnsweredBy';

import { workflowRunStyles as styles } from './workflowRunStyles';
import type {
    WorkflowInvocationRecoveryPresentation,
    WorkflowRecoveryContinuation,
} from './workflowRunDetailPresentation';
import { projectWorkflowInvocationRequests } from './workflowPermissionRequests';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';

const NO_PENDING_REQUESTS: ReadonlySet<string> = new Set();

/** Detached Run cards carry their own responder, never a Session mutation authority. */
function WorkflowRunPromptSource(props: Readonly<{ runId: string; children: React.ReactNode }>) {
    const [source] = React.useState(() => createReadOnlySessionTranscriptSource({
        sessionId: props.runId,
        messages: [],
        reducerState: null,
        metadata: null,
        agentState: null,
    }));
    return <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>;
}

/**
 * One exact selected invocation.
 *
 * Everything shown here comes from the authorized opened progress projection
 * the caller was handed: this component holds no envelope opener, no Account
 * codec and no lifecycle of its own. Which recovery actions exist is likewise
 * the recovery projection's answer, not a guess from a missing runtime handle,
 * so a possibly-active input can never be replaced from this surface.
 */
export type WorkflowInvocationDetailProps = Readonly<{
    /** The authorized opened progress for the selected row, when it has been read. */
    progress: WorkflowProgressEnvelopeV1 | null;
    /** Canonical Run final output, projected only onto its producing invocation. */
    finalResult?: Readonly<{ value: JsonValue }> | null;
    /** Status is the exact index fact, including stopped attempts without execution content. */
    lifecycle?: WorkflowInvocationLifecycleV1 | null;
    recovery: WorkflowInvocationRecoveryPresentation;
    /**
     * The workspace's source block label, already resolved against the frozen
     * definition. `null` means the workspace is not step-derived, or that block
     * is not present in the read definition.
     */
    workspaceSourceLabel: string | null;
    /** Why this row is waiting or was skipped, when its canonical facts say so. */
    cause?: string | null;
    contentUnavailable?: boolean;
    /** The review card above these facts already shows this step's result. */
    resultShownAbove?: boolean;
    /** Undefined retains older callers' notice; null means Review already presents this state. */
    contentReadState?: React.ReactNode;
    onOpenSession?: (sessionId: string) => void;
    onOpenExecutionRun?: (runId: string) => void;
    /** Read the exact historical attempt; never selects its value for this attempt. */
    onSelectInvocation?: (invocationId: string) => void;
    /**
     * Answers a request recorded for this invocation's detached Execution Run.
     * The host supplies it only while the exact evidence is confirmed; a
     * rejection is shown by the canonical card that sent it.
     */
    onRespondToRequest?: (response: ExecutionRunPromptResponse) => Promise<void>;
    /**
     * Requests whose answer is already in flight. Their controls stay
     * withdrawn until the host sees that answer settle, so the same request
     * cannot be allowed and denied in the same moment.
     */
    pendingRequestIds?: ReadonlySet<string>;
    onCopyWorkspace?: (directory: string) => void;
    onOpenWorkspace?: (workspaceRefId: string, directory: string) => void;
    onReattach?: () => void;
    onRetrySameConversation?: () => void;
    onRetryFreshAgent?: () => void;
    onRetry?: () => void;
    onRetryWithReplacement?: (input: WorkflowRecoveryContinuation) => void;
    onContinuePrepared?: (choice: WorkflowRecoveryContinuation) => void;
    /** Acknowledgement is owned by the host: it is submitted with the operation. */
    uncertaintyAcknowledged?: boolean;
    onAcknowledgeUncertainPriorEffects?: () => void;
    onStartReviewedNewRun?: () => void;
    onRunWithAnotherAgent?: () => void;
    onRestoreWorkspace?: () => void;
    /**
     * A durable Run operation the host issued is unsettled. Every durable
     * action here is withdrawn as busy until it settles; inspection, copying
     * and the reviewed text stay live.
     */
    operationPending?: boolean;
    /**
     * The reviewed text buffers for this exact invocation, owned above the
     * Activity/Flow switch.
     *
     * This detail is remounted by that switch — it is a list footer in one arm
     * and a scroll child in the other — so a buffer kept here was discarded
     * mid-sentence whenever someone checked the graph while writing a
     * continuation. `undefined` means nothing has been typed yet, which is what
     * lets a prepared continuation still seed itself from the execution owner.
     */
    continuationText: string | undefined;
    onChangeContinuationText: (next: string) => void;
    replacementText: string | undefined;
    onChangeReplacementText: (next: string) => void;
    /** The Run's Machine as the machine owner sees it; an unreachable one heads the recovery card. */
    machine?: Readonly<{ name: string; reachable: boolean }> | null;
    /** The selected Wait's authored question, when the selection is a Wait in the frozen definition. */
    waitPrompt?: string | null;
    testIDPrefix: string;
}>;

/**
 * One reviewed text buffer.
 *
 * Accepting a prepared continuation and replacing a failed step's input are two
 * different decisions, so each gets its own instance of this hook: one
 * disclosure, one draft, one submit. Sharing a single buffer between them meant
 * opening either revealed the other's half-written text — and could submit it.
 *
 * A prepared instance is seeded from whatever the execution owner already
 * resolved, so ordinary recovery is read-and-accept rather than a prompt
 * reconstruction.
 */
function useReviewedContinuation(
    prepared: WorkflowInvocationRecoveryV1 | null,
    buffer: Readonly<{ text: string | undefined; onChangeText: (next: string) => void }>,
    initiallyOpen = prepared === null,
): Readonly<{
    text: string;
    setText: (next: string) => void;
    open: boolean;
    toggle: () => void;
    document: WorkflowRecoveryContinuation['document'];
    input: WorkflowRecoveryContinuation['input'];
}> {
    const preparedDocument = prepared?.input.kind === 'replacement' ? prepared.input.value.document : null;
    const text = buffer.text ?? preparedDocument?.text ?? '';
    const setText = buffer.onChangeText;
    // The Protocol's continuation always carries an authored input. When the
    // owner prepared one there is something to accept, so editing stays
    // disclosed; when it only says "the original objective", the person has to
    // supply the continuation, so the field opens rather than hiding behind a
    // disclosure that looks optional. Text the person already wrote keeps it
    // open, so a buffer that survived a view switch is not hidden behind a
    // collapsed row — the owner's prepared seed is not such text, or a prepared
    // continuation could never open closed.
    const [open, setOpen] = React.useState(initiallyOpen || (buffer.text ?? '').length > 0);
    const toggle = React.useCallback(() => setOpen((current) => !current), []);
    return {
        text,
        setText,
        open,
        toggle,
        document: {
            text,
            references: preparedDocument?.references ?? [],
            attachments: preparedDocument?.attachments ?? [],
        },
        input: prepared?.input.kind === 'replacement' ? prepared.input.value.input : [],
    };
}

export function WorkflowInvocationDetail(props: WorkflowInvocationDetailProps): React.ReactElement {
    const { theme } = useUnistyles();
    const { recovery, testIDPrefix } = props;
    const execution = props.progress?.execution;
    const answeredBy = useAnsweredByLabel(props.progress?.review?.resultSource);
    const visibleResult = props.finalResult != null ? props.finalResult.value : props.progress?.result;
    const workspace = recovery.workspace;
    // A step that worked in the home folder with nothing else to say ("~") gets no row (FIN-DESIGN-REVIEW H4).
    const workspaceInformative = workspace != null && (workspace.displayDirectory !== '~' || workspace.branchName !== null
        || workspace.checkoutRootPath !== workspace.directory || props.workspaceSourceLabel != null);
    const prepared = recovery.preparedRecovery;
    const continuation = useReviewedContinuation(prepared, {
        text: props.continuationText,
        onChangeText: props.onChangeContinuationText,
    });
    /** The replacement retry's own buffer; it never inherits the prepared text. */
    const replacement = useReviewedContinuation(null, {
        text: props.replacementText,
        onChangeText: props.onChangeReplacementText,
    }, false);
    /**
     * Which conversation a replacement retry uses.
     *
     * The execution owner may allow both; choosing by "whichever capability is
     * true first" made the fresh-agent arm unreachable whenever same-conversation
     * recovery was also available. Same conversation stays the default because it
     * preserves the agent's history.
     */
    const [replacementConversation, setReplacementConversation] =
        React.useState<WorkflowRecoveryContinuation['conversation']>(
            recovery.canRetrySameConversation ? 'same_conversation' : 'fresh_agent',
        );
    const replacementConversationChoices = ([
        ...(recovery.canRetrySameConversation ? ['same_conversation' as const] : []),
        ...(recovery.canRetryFreshAgent ? ['fresh_agent' as const] : []),
    ]);
    const effectiveReplacementConversation = replacementConversationChoices.includes(replacementConversation)
        ? replacementConversation
        : replacementConversationChoices[0] ?? 'same_conversation';
    // Blocked until this exact attempt is acknowledged; nothing here can bypass
    // an unresolved outcome, which stays the Action owner's refusal.
    const acknowledgementSatisfied = !recovery.requiresUncertaintyAcknowledgement
        || props.uncertaintyAcknowledged === true;
    const operationPending = props.operationPending === true;
    // The Protocol's continuation input is required and its text is non-empty,
    // so an unwritten continuation is refused here rather than rejected later.
    const continuationSubmittable = acknowledgementSatisfied
        && continuation.document.text.trim().length > 0
        && !operationPending;
    const replacementSubmittable = acknowledgementSatisfied
        && replacement.document.text.trim().length > 0
        && !operationPending;
    const retryable = acknowledgementSatisfied && !operationPending;
    const pendingRequests = React.useMemo(() => projectWorkflowInvocationRequests(props.progress), [props.progress]);
    /**
     * Requests are answered through the canonical Session prompt cards,
     * addressed to the one Execution Run that owns them. Only a detached run
     * records them here; nothing about this invocation grants a Session's
     * authority, and last-known content that could not be confirmed as current
     * is shown without a responder.
     */
    const detachedExecutionRunId = props.progress?.execution?.kind === 'detached_run'
        ? props.progress.execution.runId
        : null;
    const respondToRequest = props.contentUnavailable === true ? undefined : props.onRespondToRequest;
    const pendingRequestIds = props.pendingRequestIds ?? NO_PENDING_REQUESTS;
    const executionRunTarget = React.useMemo((): ExecutionRunPromptResponseTarget | null => (
        detachedExecutionRunId === null ? null : {
            executionRunId: detachedExecutionRunId,
            pendingRequestIds,
            ...(respondToRequest === undefined ? {} : { respond: respondToRequest }),
        }
    ), [detachedExecutionRunId, pendingRequestIds, respondToRequest]);
    const attempt = props.progress === null ? null : describeWorkflowInvocationAttempt(props.progress.attempt);
    const stopped = props.lifecycle === 'cancelled' || props.lifecycle === 'cancel_requested';
    const resultContract = React.useMemo(() => {
        const parsed = WorkflowResultContractSchema.safeParse(props.progress?.resultContract);
        return parsed.success ? parsed.data : undefined;
    }, [props.progress?.resultContract]);
    const previousAttemptRecordId = props.progress?.previousAttemptRecordId;
    // Missing usage carries no reported fact; container frames run no agent.
    const usageLabel = props.progress === null || props.progress.blockKind !== 'step'
        ? null
        : props.progress.usage === undefined
            ? null
            : formatWorkflowUsageLabel(props.progress.usage, {
                tokens: t('usage.tokens'),
                input: t('usage.tokenMix.input'),
                output: t('usage.tokenMix.output'),
            });

    // The choices this attempt really has: the recovery projection's answer, joined with the host's wiring.
    const preparedOffered = recovery.canContinuePrepared && prepared !== null && props.onContinuePrepared !== undefined;
    const reattachOffered = recovery.canReattach && props.onReattach !== undefined;
    const retrySameOffered = recovery.canRetrySameConversation && props.onRetrySameConversation !== undefined;
    const retryFreshOffered = recovery.canRetryFreshAgent && props.onRetryFreshAgent !== undefined;
    const retryOffered = recovery.canRetry && props.onRetry !== undefined;
    const replacementOffered = (recovery.canRetrySameConversation || recovery.canRetryFreshAgent)
        && props.onRetryWithReplacement !== undefined;
    const restoreOffered = recovery.workspaceUnavailable && recovery.canRestoreWorkspace
        && props.onRestoreWorkspace !== undefined;
    const reviewedNewRunOffered = recovery.workspaceUnavailable && recovery.canStartReviewedNewRun
        && props.onStartReviewedNewRun !== undefined;
    const anotherAgentOffered = recovery.canRunWithAnotherAgent && props.onRunWithAnotherAgent !== undefined;
    // One primary: the first offered choice, in the order the lab ranks them; the rest stay secondary.
    const offeredChoices = ([
        ['prepared', preparedOffered], ['reattach', reattachOffered], ['same', retrySameOffered],
        ['fresh', retryFreshOffered], ['retry', retryOffered], ['restore', restoreOffered], ['reviewed', reviewedNewRunOffered],
        ['another', anotherAgentOffered],
    ] as const).filter(([, offered]) => offered).map(([choice]) => choice);
    const choiceDisplay = (choice: (typeof offeredChoices)[number]) => offeredChoices[0] === choice ? 'default' as const : 'secondary' as const;
    const choiceOffered = offeredChoices.length > 0 || replacementOffered;
    // Only this attempt's recorded failure explains what happened. Connectivity only affects recovery.
    const failureCause = recovery.failureCause ?? null;
    const unavailableMachine = recovery.unavailableMachine ?? null;
    const unreadable = props.contentUnavailable === true && failureCause === null && !choiceOffered;
    const showRecoveryCard = !unreadable && (choiceOffered || recovery.workspaceUnavailable || failureCause !== null
        || props.lifecycle === 'failed' || props.lifecycle === 'outcome_uncertain');
    const reportedMessage = failureCause?.kind === 'reported_failure' ? failureCause.headline : null;
    const causeHeadline = reportedMessage
        ?? props.cause
        ?? (failureCause?.kind === 'cause_not_recorded' ? t('workflows.recovery.causeNotRecorded') : null)
        ?? t('workflows.recovery.didNotFinish');
    // With choices, the description says what they keep; without, the one sentence saying when they
    // appear is the sheet's content, so the card never draws an empty tinted sheet under its title.
    const recoveryDescription = choiceOffered ? t('workflows.recovery.keptBody') : undefined;
    const noChoicesLine = choiceOffered || recovery.workspaceUnavailable || recovery.waitingForStop
        || (recovery.remainingNotStartedSiblingCount ?? 0) > 0 ? null
        : unavailableMachine !== null
            ? t('workflows.recovery.choicesOnReconnect', { machine: unavailableMachine.name })
            : t('workflows.recovery.noChoices');
    // An interruption needs you; only a reported failure reads as failed (lab run-A_failed / _interrupted).
    // With nothing to choose yet nothing needs you, so the card stays quiet (DESIGN-18 R1b).
    const recoveryTone = !choiceOffered ? 'neutral' as const
        : reportedMessage === null && unavailableMachine !== null
            || props.lifecycle !== 'failed' ? 'attention' as const : 'danger' as const;
    // The acknowledgement row explains itself unless the card's head already says it (an uncertain step).
    const headSaysEffects = props.lifecycle === 'outcome_uncertain' && props.cause != null && causeHeadline === props.cause;
    // A reported failure's typed code (and its raw cause, when the head says something else) waits under
    // Technical details, one tap away from the readable head (lab run-R1 failed inspector). The recovery
    // owner decides which attempts carry one; a finished step never does.
    const reportedFailure = failureCause?.kind === 'reported_failure' ? failureCause : null;
    const technicalLines = React.useMemo((): TechnicalDetailsLine[] => {
        if (reportedFailure === null) return [];
        const lines: TechnicalDetailsLine[] = [
            { key: 'failure-code', label: t('workflows.run.technical.failureCode'), value: reportedFailure.code },
        ];
        if (reportedFailure.message !== null && reportedFailure.message.length > 0 && reportedFailure.message !== causeHeadline) {
            lines.push({ key: 'failure-cause', label: t('workflows.run.technical.failureCause'), value: reportedFailure.message });
        }
        return lines;
    }, [causeHeadline, reportedFailure]);
    const sessionLink = (execution?.kind === 'session' || execution?.kind === 'session_ready')
        && recovery.canInspectExecution && props.onOpenSession !== undefined ? execution.sessionId : null;
    const executionLink = execution?.kind === 'detached_run'
        && recovery.canInspectExecution && props.onOpenExecutionRun !== undefined ? execution.runId : null;

    return (
        <View testID={`${testIDPrefix}-selected-detail`} style={styles.section}>
            {/* The state and the time are the pane's subtitle (DESIGN-16 D5); the body says what happened. */}
            {props.contentUnavailable === true ? props.contentReadState !== undefined ? props.contentReadState : (
                <Text
                    testID={`${testIDPrefix}-content-unavailable`}
                    style={styles.provenance}
                    accessibilityRole="text"
                    accessibilityLiveRegion="polite"
                    role="status"
                >
                    {/* Two different situations wore the same sentence. With
                        nothing opened the private content genuinely cannot be
                        read here; with last-known content still on screen the
                        honest statement is that it could not be confirmed as
                        current — and its actions are withdrawn above. */}
                    {props.progress === null
                        ? t('workflows.contentUnavailable')
                        : t('workflows.run.evidenceStale')}
                </Text>
            ) : null}
            {/* A retried attempt says which one it is, in the same words as its row. */}
            {attempt?.retried ? (
                <Text testID={`${testIDPrefix}-invocation-attempt`} style={styles.provenance}>
                    {attempt.label}
                </Text>
            ) : null}
            {previousAttemptRecordId === undefined || props.onSelectInvocation === undefined ? null : (
                <HappierPressable testID={`${testIDPrefix}-previous-attempt`} accessibilityRole="link"
                    onPress={() => props.onSelectInvocation?.(previousAttemptRecordId)} style={(state) => [styles.actionTarget, styles.focusTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                    <Text style={styles.action}>{t('workflows.review.previousAttempt')}</Text>
                </HappierPressable>
            )}
            {showRecoveryCard || props.cause === undefined || props.cause === null ? null : (
                <Text testID={`${testIDPrefix}-invocation-cause`} style={styles.provenance}>
                    {props.cause}
                </Text>
            )}
            {/* A finished step's retained reason belongs to an earlier attempt; it never reads beside success. */}
            {showRecoveryCard || props.lifecycle === 'completed' || props.progress?.reason?.message === undefined ? null : (
                <Text style={styles.provenance}>{props.progress.reason.message}</Text>
            )}
            {executionRunTarget === null || pendingRequests.length === 0 ? null : (
                <WorkflowRunPromptSource key={executionRunTarget.executionRunId} runId={executionRunTarget.executionRunId}>
                <View testID={`${testIDPrefix}-permission-requests`} style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('workflows.run.needsYou')}</Text>
                    {pendingRequests.map((request) => {
                        const pendingRequest = {
                            id: request.requestId,
                            tool: request.tool,
                            kind: request.kind,
                            arguments: request.arguments,
                            createdAt: null,
                        };
                        return request.kind === 'user_action' ? (
                            <UserActionPromptCard
                                key={request.requestId}
                                request={pendingRequest}
                                location={null}
                                executionRun={executionRunTarget}
                                metadata={null}
                                canApprovePermissions={true}
                            />
                        ) : (
                            <PermissionPromptCard
                                key={request.requestId}
                                request={pendingRequest}
                                location={null}
                                executionRun={executionRunTarget}
                                metadata={null}
                                canApprovePermissions={true}
                            />
                        );
                    })}
                </View>
                </WorkflowRunPromptSource>
            )}
            {/*
              * Recovery leads the pane (lab run-A_failed / run-A_interrupted, DESIGN-17 R1): one card in the
              * hold card's anatomy, headed by what happened, then only the choices the recovery projection
              * offers, each with its consequence and one primary. With none, the card says when they appear.
              */}
            {!showRecoveryCard ? null : (
                <View testID={`${testIDPrefix}-recovery-card`}><ListPresentationProvider value="page">
                    {/* The card leads the pane under its own header; no section spacer above it. */}
                    <ItemGroup header="none" containerStyle={workStatusSurfaceStyle(recoveryTone) ?? undefined}>
                        {/* The card's head, inside its sheet as the hold card's is: what happened, then what it means now. */}
                        <Item
                            testID={`${testIDPrefix}-recovery-cause`}
                            title={causeHeadline}
                            titleLines={0}
                            subtitle={recoveryDescription ?? noChoicesLine ?? undefined}
                            subtitleLines={0}
                            showChevron={false}
                        />
                        {failureCause?.kind === 'reported_failure' && failureCause.reset ? (
                            <SectionContentRow>
                                <Text testID={`${testIDPrefix}-runtime-issue-reset`} style={styles.provenance}>
                                    {failureCause.reset}
                                </Text>
                            </SectionContentRow>
                        ) : null}
                        {recovery.remainingNotStartedSiblingCount === null
                            || recovery.remainingNotStartedSiblingCount === 0 ? null : (
                                <SectionContentRow>
                                    <Text testID={`${testIDPrefix}-remaining-not-started`} style={styles.provenance}>
                                        {t('workflows.recovery.remainingNotStarted', {
                                            count: recovery.remainingNotStartedSiblingCount,
                                        })}
                                    </Text>
                                </SectionContentRow>
                            )}
                        {/*
                          * Uncertain prior effects are acknowledged for this exact attempt, above the choices
                          * they gate — never as a blanket setting and never inherited from a sibling selection.
                          */}
                        {recovery.requiresUncertaintyAcknowledgement
                            && props.onAcknowledgeUncertainPriorEffects !== undefined ? (
                                <Item
                                    testID={`${testIDPrefix}-uncertain-effects`}
                                    title={t('workflows.recovery.acknowledgeEffects')}
                                    subtitle={headSaysEffects ? undefined : t('workflows.recovery.uncertainEffects', {
                                        block: props.workspaceSourceLabel ?? t('workflows.run.untitled'),
                                    })}
                                    showChevron={false}
                                    rightElementOutsidePressable
                                    rightElement={(
                                        <Switch
                                            testID={`${testIDPrefix}-acknowledge-uncertain`}
                                            accessibilityLabel={t('workflows.recovery.acknowledgeEffects')}
                                            value={props.uncertaintyAcknowledged === true}
                                            onValueChange={() => props.onAcknowledgeUncertainPriorEffects?.()}
                                        />
                                    )}
                                />
                            ) : null}
                        {/*
                          * A prepared continuation: the execution owner already resolved the objective, result
                          * contract and recorded context, so continuing is one press. Editing it is disclosed.
                          */}
                        {preparedOffered && prepared !== null ? (
                            <View testID={`${testIDPrefix}-prepared-recovery`}>
                                <Item
                                    title={prepared.conversation === 'same_conversation'
                                        ? t('workflows.recovery.sameConversationTitle')
                                        : t('workflows.recovery.freshAgent')}
                                    subtitle={prepared.conversation === 'same_conversation'
                                        ? t('workflows.recovery.resumeSameConversationExplain', {
                                            block: props.workspaceSourceLabel ?? t('workflows.run.untitled'),
                                        })
                                        : t('workflows.recovery.freshAgentExplain')}
                                    showChevron={false}
                                    rightElementOutsidePressable
                                    rightElement={(
                                        <RoundButton
                                            testID={`${testIDPrefix}-continue-prepared`}
                                            size="small"
                                            display={choiceDisplay('prepared')}
                                            loading={operationPending}
                                            disabled={!continuationSubmittable}
                                            title={prepared.conversation === 'same_conversation'
                                                ? t('workflows.recovery.resumeSameConversation')
                                                : t('workflows.recovery.startFresh')}
                                            onPress={() => {
                                                if (!continuationSubmittable) return;
                                                props.onContinuePrepared?.({
                                                    conversation: prepared.conversation,
                                                    document: continuation.document,
                                                    input: continuation.input,
                                                });
                                            }}
                                        />
                                    )}
                                />
                                <Item
                                    testID={`${testIDPrefix}-edit-continuation`}
                                    title={t('workflows.recovery.editContinuation')}
                                    accessibilityRole="button"
                                    accessibilityExpanded={continuation.open}
                                    showChevron={false}
                                    onPress={continuation.toggle}
                                />
                                {continuation.open ? (
                                    <SectionContentRow>
                                        <MultiTextInput
                                            testID={`${testIDPrefix}-continuation-input`}
                                            value={continuation.text}
                                            onChangeText={continuation.setText}
                                            placeholder={t('workflows.recovery.continuationPlaceholder')}
                                            accessibilityLabel={t('workflows.recovery.continuationPlaceholder')}
                                            submitBehavior="newline"
                                        />
                                    </SectionContentRow>
                                ) : null}
                            </View>
                        ) : null}
                        {reattachOffered ? (
                            <Item
                                title={t('workflows.recovery.reattach')}
                                subtitle={t('workflows.recovery.reattachExplain')}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-reattach`}
                                        size="small"
                                        display={choiceDisplay('reattach')}
                                        loading={operationPending}
                                        disabled={operationPending}
                                        title={t('workflows.recovery.reattach')}
                                        onPress={props.onReattach}
                                    />
                                )}
                            />
                        ) : null}
                        {retrySameOffered ? (
                            <Item
                                title={t('workflows.recovery.sameConversationTitle')}
                                subtitle={t('workflows.recovery.resumeSameConversationExplain', {
                                    block: props.workspaceSourceLabel ?? t('workflows.run.untitled'),
                                })}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-retry-same`}
                                        size="small"
                                        display={choiceDisplay('same')}
                                        loading={operationPending}
                                        disabled={!retryable}
                                        title={t('workflows.recovery.resumeSameConversation')}
                                        onPress={() => {
                                            if (!retryable) return;
                                            props.onRetrySameConversation?.();
                                        }}
                                    />
                                )}
                            />
                        ) : null}
                        {retryFreshOffered ? (
                            <Item
                                title={t('workflows.recovery.freshAgent')}
                                subtitle={t('workflows.recovery.freshAgentBody')}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-retry-fresh`}
                                        size="small"
                                        display={choiceDisplay('fresh')}
                                        loading={operationPending}
                                        disabled={!retryable}
                                        title={t('workflows.recovery.startFresh')}
                                        onPress={() => {
                                            if (!retryable) return;
                                            props.onRetryFreshAgent?.();
                                        }}
                                    />
                                )}
                            />
                        ) : null}
                        {retryOffered ? (
                            <Item
                                title={t('workflows.recovery.retry')}
                                subtitle={t('workflows.recovery.retryExplain')}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-retry`}
                                        size="small"
                                        display={choiceDisplay('retry')}
                                        loading={operationPending}
                                        disabled={!retryable}
                                        title={t('workflows.recovery.retry')}
                                        onPress={() => {
                                            if (!retryable) return;
                                            props.onRetry?.();
                                        }}
                                    />
                                )}
                            />
                        ) : null}
                        {/* Retry distinguishes repeating the original input from an inspected replacement. */}
                        {replacementOffered ? (
                            <View testID={`${testIDPrefix}-retry-replacement`}>
                                <Item
                                    testID={`${testIDPrefix}-use-replacement-input`}
                                    title={t('workflows.recovery.useReplacementInput')}
                                    accessibilityRole="button"
                                    accessibilityExpanded={replacement.open}
                                    showChevron={false}
                                    onPress={replacement.toggle}
                                />
                                {replacement.open ? (
                                    <SectionContentRow>
                                        <MultiTextInput
                                            testID={`${testIDPrefix}-replacement-input`}
                                            value={replacement.text}
                                            onChangeText={replacement.setText}
                                            placeholder={t('workflows.recovery.continuationPlaceholder')}
                                            accessibilityLabel={t('workflows.recovery.continuationPlaceholder')}
                                            submitBehavior="newline"
                                        />
                                        <View style={styles.actions}>
                                            {replacementConversationChoices.length < 2 ? null : (
                                                <View
                                                    accessibilityRole="radiogroup"
                                                    accessibilityLabel={t('workflows.conversation.title')}
                                                    style={styles.actions}
                                                >
                                                    {replacementConversationChoices.map((choice) => (
                                                        <HappierPressable
                                                            key={choice}
                                                            testID={`${testIDPrefix}-replacement-conversation-${choice}`}
                                                            accessibilityRole="radio"
                                                            checked={effectiveReplacementConversation === choice}
                                                            accessibilityLabel={choice === 'same_conversation'
                                                                ? t('workflows.recovery.resumeSameConversation')
                                                                : t('workflows.recovery.freshAgent')}
                                                            onPress={() => setReplacementConversation(choice)}
                                                            style={(state) => [styles.actionTarget, styles.focusTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                                                        >
                                                            <Text style={effectiveReplacementConversation === choice
                                                                ? styles.action
                                                                : styles.provenance}
                                                            >
                                                                {choice === 'same_conversation'
                                                                    ? t('workflows.recovery.resumeSameConversation')
                                                                    : t('workflows.recovery.freshAgent')}
                                                            </Text>
                                                        </HappierPressable>
                                                    ))}
                                                </View>
                                            )}
                                            <RoundButton
                                                testID={`${testIDPrefix}-submit-replacement`}
                                                size="small"
                                                loading={operationPending}
                                                disabled={!replacementSubmittable}
                                                title={t('workflows.run.retryStep')}
                                                onPress={() => {
                                                    if (!replacementSubmittable) return;
                                                    props.onRetryWithReplacement?.({
                                                        conversation: effectiveReplacementConversation,
                                                        document: replacement.document,
                                                        input: replacement.input,
                                                    });
                                                }}
                                            />
                                        </View>
                                    </SectionContentRow>
                                ) : null}
                            </View>
                        ) : null}
                        {/*
                          * Exactly one of D4's arms is reachable, so the row names that one. Restoring keeps
                          * this Run's completed work; only the reviewed new Run can repeat it.
                          */}
                        {restoreOffered ? (
                            <Item
                                title={t('workflows.workspace.restore')}
                                subtitle={t('workflows.workspace.unavailableRestoreBody')}
                                subtitleTestID={`${testIDPrefix}-workspace-unavailable-body`}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-restore-workspace`}
                                        size="small"
                                        display={choiceDisplay('restore')}
                                        loading={operationPending}
                                        disabled={operationPending}
                                        title={t('workflows.workspace.restore')}
                                        onPress={props.onRestoreWorkspace}
                                    />
                                )}
                            />
                        ) : null}
                        {reviewedNewRunOffered ? (
                            <Item
                                title={t('workflows.recovery.startReviewedRun')}
                                subtitle={recovery.workspaceUnavailable
                                    ? t('workflows.workspace.unavailableNewRunBody')
                                    : t('workflows.recovery.repeatedEffectWarning')}
                                subtitleTestID={recovery.workspaceUnavailable ? `${testIDPrefix}-workspace-unavailable-body` : undefined}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-start-reviewed-new-run`}
                                        size="small"
                                        display={choiceDisplay('reviewed')}
                                        title={t('workflows.recovery.startReviewedRun')}
                                        onPress={props.onStartReviewedNewRun}
                                    />
                                )}
                            />
                        ) : null}
                        {anotherAgentOffered ? (
                            <Item
                                title={t('workflows.start.runWithAnotherAgent')}
                                subtitle={t('workflows.recovery.repeatedEffectWarning')}
                                showChevron={false}
                                rightElementOutsidePressable
                                rightElement={(
                                    <RoundButton
                                        testID={`${testIDPrefix}-run-another-agent`}
                                        size="small"
                                        display={choiceDisplay('another')}
                                        loading={operationPending}
                                        disabled={operationPending}
                                        title={t('workflows.start.runWithAnotherAgent')}
                                        onPress={props.onRunWithAnotherAgent}
                                    />
                                )}
                            />
                        ) : null}
                        {recovery.workspaceUnavailable && !restoreOffered && !reviewedNewRunOffered ? (
                            <SectionContentRow>
                                <Text testID={`${testIDPrefix}-workspace-unavailable-body`} style={styles.provenance}>
                                    {t('workflows.workspace.unavailableBody')}
                                </Text>
                            </SectionContentRow>
                        ) : null}
                        {recovery.waitingForStop ? (
                            <SectionContentRow>
                                <Text testID={`${testIDPrefix}-recovery-waiting-for-stop`} style={styles.provenance}>
                                    {t('workflows.recovery.waitingForStop')}
                                </Text>
                            </SectionContentRow>
                        ) : null}
                    </ItemGroup>
                </ListPresentationProvider></View>
            )}
            {showRecoveryCard || recovery.remainingNotStartedSiblingCount === null
                || recovery.remainingNotStartedSiblingCount === 0 ? null : (
                    <Text testID={`${testIDPrefix}-remaining-not-started`} style={styles.provenance}>
                        {t('workflows.recovery.remainingNotStarted', {
                            count: recovery.remainingNotStartedSiblingCount,
                        })}
                    </Text>
                )}
            {showRecoveryCard || !recovery.waitingForStop ? null : (
                <Text testID={`${testIDPrefix}-recovery-waiting-for-stop`} style={styles.provenance}>
                    {t('workflows.recovery.waitingForStop')}
                </Text>
            )}
            {props.resultShownAbove !== true && (visibleResult !== undefined || (props.waitPrompt != null && (stopped || props.lifecycle === 'completed'))) ? (
                // The answer reads as the card it was typed in: the Wait's question heads it and the value
                // sits in the review card's own rows (DESIGN-16 D4, D5). Any other step's own result heads
                // "Result"; "Final output" is the Run's, and only one step carries it.
                <View testID={`${testIDPrefix}-invocation-result`}><ListPresentationProvider value="page">
                    <ItemGroup title={props.waitPrompt ?? t('workflows.input.result')}>
                        {visibleResult !== undefined ? (
                            <>
                                <WorkflowReviewValue value={visibleResult}
                                    contract={props.finalResult != null ? undefined : resultContract}
                                    testIDPrefix={`${testIDPrefix}-invocation-result`} />
                                {answeredBy === null ? null : (
                                    <SectionContentRow testID={`${testIDPrefix}-invocation-answered-by`}>
                                        <Text style={styles.provenance}>{answeredBy}</Text>
                                    </SectionContentRow>
                                )}
                            </>
                        ) : stopped ? (
                            <SectionContentRow testID={`${testIDPrefix}-invocation-unanswered`}>
                                <Text style={styles.provenance}>{t('workflows.run.notAnswered')}</Text>
                            </SectionContentRow>
                        ) : (
                            // A completed Wait with nothing to fill in was continued, not left unanswered.
                            <SectionContentRow testID={`${testIDPrefix}-invocation-continued`}>
                                <Text style={styles.provenance}>{answeredBy ?? t('workflows.run.waitContinued')}</Text>
                            </SectionContentRow>
                        )}
                    </ItemGroup>
                </ListPresentationProvider></View>
            ) : null}
            {props.progress?.input === undefined ? null : (
                // What the step was given reads in the same card anatomy as what it returned.
                <View testID={`${testIDPrefix}-invocation-input`}><ListPresentationProvider value="page" pageInsets={props.resultShownAbove === true ? 'contained' : 'standard'}>
                    <ItemGroup title={t('workflows.input.label')}>
                        <WorkflowReviewValue value={props.progress.input} contract={undefined}
                            testIDPrefix={`${testIDPrefix}-invocation-input`} />
                    </ItemGroup>
                </ListPresentationProvider></View>
            )}
            {/*
              * The quiet facts in one meta block (DESIGN-17 R1): usage, where the step worked, and where
              * to inspect it. Only reported usage reads here.
              */}
            {usageLabel === null && !workspaceInformative && sessionLink === null && executionLink === null
                && technicalLines.length === 0 ? null : (
                <View testID={`${testIDPrefix}-invocation-meta`}><ListPresentationProvider value="page" pageInsets={props.resultShownAbove === true ? 'contained' : 'standard'}>
                    <ItemGroup header="none">
                        {usageLabel === null ? null : (
                            <Item
                                title={t('usage.tokens')}
                                showChevron={false}
                                mode="info"
                                rightElement={(
                                    <Text
                                        testID={`${testIDPrefix}-invocation-usage`}
                                        style={styles.metric}
                                    >
                                        {usageLabel}
                                    </Text>
                                )}
                            />
                        )}
                        {!workspaceInformative || workspace === null ? null : (
                            <Item
                                testID={`${testIDPrefix}-workspace`}
                                title={t('workflows.workspace.title')}
                                subtitle={workspace.displayDirectory}
                                subtitleTestID={`${testIDPrefix}-workspace-path`}
                                subtitleStyle={styles.detailValue}
                                showChevron={false}
                                mode="info"
                                bottomElementInset="text"
                                bottomElement={(
                                    <View style={styles.section}>
                                        {workspace.checkoutRootPath === workspace.directory ? null : (
                                            <Text testID={`${testIDPrefix}-workspace-checkout-root`} style={styles.provenance}>
                                                {t('workflows.workspace.projectCheckout')}: {workspace.displayCheckoutRootPath}
                                            </Text>
                                        )}
                                        {workspace.branchName === null ? null : (
                                            <Text testID={`${testIDPrefix}-workspace-branch`} style={styles.provenance}>
                                                {t('workflows.editor.branch')}: {workspace.branchName}
                                            </Text>
                                        )}
                                        {props.workspaceSourceLabel === null ? null : (
                                            <Text testID={`${testIDPrefix}-workspace-source`} style={styles.provenance}>
                                                {t('workflows.workspace.fromStep', { block: props.workspaceSourceLabel })}
                                            </Text>
                                        )}
                                        {props.onCopyWorkspace === undefined
                                            && (workspace.workspaceRefId === null || props.onOpenWorkspace === undefined) ? null : (
                                                <View style={styles.actions}>
                                                    {props.onCopyWorkspace === undefined ? null : (
                                                        <ToolbarButton
                                                            testID={`${testIDPrefix}-copy-workspace`}
                                                            label={t('files.repositoryTree.actions.copyPath')}
                                                            onPress={() => props.onCopyWorkspace?.(workspace.directory)}
                                                            size="md"
                                                        />
                                                    )}
                                                    {workspace.workspaceRefId === null || props.onOpenWorkspace === undefined ? null : (
                                                        <ToolbarButton
                                                            testID={`${testIDPrefix}-open-workspace`}
                                                            label={t('sessionInfo.openWorkspaceTitle')}
                                                            onPress={() => props.onOpenWorkspace?.(
                                                                workspace.workspaceRefId!,
                                                                workspace.directory,
                                                            )}
                                                            size="md"
                                                        />
                                                    )}
                                                </View>
                                            )}
                                    </View>
                                )}
                            />
                        )}
                        {sessionLink === null ? null : (
                            <Item
                                testID={`${testIDPrefix}-open-session`}
                                title={t('workflows.run.openSourceSession')}
                                accessibilityRole="link"
                                onPress={() => props.onOpenSession?.(sessionLink)}
                            />
                        )}
                        {executionLink === null ? null : (
                            <Item
                                testID={`${testIDPrefix}-open-execution-run`}
                                title={t('workflows.run.openExecution')}
                                accessibilityRole="link"
                                onPress={() => props.onOpenExecutionRun?.(executionLink)}
                            />
                        )}
                        {technicalLines.length === 0 ? null : (
                            <TechnicalDetailsDisclosure
                                testID={`${testIDPrefix}-invocation-technical`}
                                title={t('workflows.run.technicalDetails')}
                                lines={technicalLines}
                            />
                        )}
                    </ItemGroup>
                </ListPresentationProvider></View>
            )}
        </View>
    );
}
