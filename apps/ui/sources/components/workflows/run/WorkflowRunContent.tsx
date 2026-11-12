import * as React from 'react';
import { useWorkflowNavigation, selectWorkflowNavigationItem } from '../navigation/workflowNavigation';
import { WorkflowPageNavigation } from '../navigation/WorkflowNavigationViews';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { normalizeResultPreview } from '@/components/workflows/presentation/resultPreview';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import {
    ScrollView,
    View,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import {
    type WorkflowDefinitionV1} from '@happier-dev/protocol/workflows/workflowV1';
import {
    type JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import {
    type WorkflowMaterializedLeafV1} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import {
    type WorkflowInvocationRecoveryV1,
    type WorkflowInvocationRecoveryAvailabilityV1,
    type WorkflowRunInvocationIndexV1,
    type WorkflowRunSummaryV1,
    type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { formatWorkflowInvocationElapsedLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import { resolveWorkflowRunProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import {
    canResumeWorkflowRunBoundary,
    isWorkflowAttentionInvocation,
    describeWorkflowInvocationLifecycle,
    describeWorkflowInvocationAttempt,
    describeWorkflowRunState,
    isWorkflowWaitForYouHold,
    isTerminalWorkflowRunState,
    isWorkflowRunStopPending,
    summarizeWorkflowInvocationCoverage,
    resolveWorkflowRunPrimaryAction,
    formatWorkflowFailureRemedyLabel,
    type WorkflowFailureRemedy,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';
import { projectWorkflowFlow, resolveWorkflowFlowScopedNodeId } from '@/components/workflows/flow/workflowFlowProjection';
import { WorkflowFlowView } from '@/components/workflows/flow/WorkflowFlowView';
import { WorkflowRunStateMark } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { readPressFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import type { CustomModalInjectedProps } from '@/modal';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { DEFAULT_SESSION_WIDTH_PX } from '@/components/ui/panels/paneBreakpoints';
import { compareInvocationOrder } from '@/sync/store/domains/workflowRuns';
import type { PaneMainColumnDescriptor } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { usePaneHeaderScrollSink } from '@/components/appShell/panes/paneHeaderScroll';
import { useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { SessionInPane } from '@/components/sessions/panes/SessionInPane';
import { useSessionInteractionSource } from '@/sync/domains/state/storage';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useDeviceType } from '@/utils/platform/responsive';
import { useUnistyles } from 'react-native-unistyles';

import { WorkflowInvocationDetail, type WorkflowInvocationDetailProps } from './WorkflowInvocationDetail';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { WorkflowRunPublicationRequestRow } from './WorkflowRunPublicationRequestRow';
import type { WorkflowRunPublicationRequest } from './useWorkflowRunPublicationRequests';
import { useWorkflowCardModal } from './useWorkflowCardModal';
import { WorkflowInvocationList } from './WorkflowInvocationList';
import { WorkflowRunSteps } from './WorkflowRunSteps';
import { WorkflowAcceptedRunRoles } from './WorkflowRunRoles';
import {
    compareWorkflowOccurrences,
    projectWorkflowFlowRunStates,
    formatWorkflowOccurrenceLabel,
    createWorkflowInvocationStructureProjector,
    type WorkflowInvocationStructureEntry,
    type WorkflowOccurrenceCoordinate,
} from './workflowInvocationStructure';
import { workflowRunStyles as styles } from './workflowRunStyles';
import { WorkflowRunNeedsYouDock } from './WorkflowRunNeedsYouDock';
import {
    formatWorkflowRunOriginLabel,
    formatWorkflowRunOutcomeLabel,
    formatWorkflowRunOutcomeLine,
    formatWorkflowRunOutcomeSentence,
    describeWorkflowSetupOutcome,
    formatWorkflowRunConsequenceSentence,
    formatWorkflowWorkspaceSourceLabel,
    describeWorkflowInvocationCause,
    projectWorkflowInvocationRecovery,
    projectWorkflowRunFailure,
    selectWorkflowRunFailureInvocation,
    selectWorkflowRunApprovalPresentation,
    type WorkflowRunFailurePresentation,
    type WorkflowRecoveryContinuation,
} from './workflowRunDetailPresentation';
import { formatWorkflowRunFailureCauseLine, resolveWorkflowRecoveryChoices, workflowRunOutcomeIsAttention } from './workflowRunDetailPresentation';

/**
 * One managed Run's detail body, shared by the exact Run route, the Automation
 * provenance wrapper and any agent-origin entry.
 *
 * Composition is outcome first: what happened, then what needs you, then the
 * timeline, then technical detail behind deliberate disclosure. Nothing here
 * derives a lifecycle — every status comes from the canonical projection the
 * caller was handed, and a control shows the durable intent it submitted rather
 * than claiming the effect already applied.
 */

export type WorkflowRunDetailView = 'activity' | 'flow' | 'steps';

/**
 * The durable operations a Run accepts against its `expectedRevision`. The
 * host issues one at a time; while any is unsettled every other one is
 * withdrawn here as busy, so the person cannot race their own request.
 */
export type WorkflowRunOperationKind =
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'retry'
    | 'continue'
    | 'reattach'
    | 'restore_workspace'
    | 'delete';

export type WorkflowRunContentProps = Readonly<{
    active?: boolean;
    serverId?: string | null;
    /** Exact Session resolved by the canonical conversation owner, including shared conversations. */
    selectedSessionId?: string | null;
    /** Phone's exact invocation route, pushed by the route owner. */
    invocationPage?: boolean;
    renderReviewCard?: (onDiscuss?: () => void, placement?: Readonly<{ compact: boolean; title: string; subtitle: string | null; belowResult?: React.ReactNode }>) => React.ReactNode;
    run: WorkflowRunSummaryV1;
    /** Frozen Account-private title; null means explicitly unavailable. */
    title?: string | null;
    /** The frozen Machine's display name, as the machine owner resolves it; absent keeps the exact id. */
    machineName?: string | null;
    /**
     * Whether the machine owner currently sees that Machine online. Absent
     * means not known here, which states nothing about contact.
     */
    machineReachable?: boolean;
    /** Last actual Machine presence observation; never the current refresh time. */
    machineLastSeenAt?: number | null;
    /** Qualified power/wake presentation from the canonical Machine status owner. */
    machineStatus?: WorkStatusPresentation;
    /** A quiet observation request, independent of durable Run controls. */
    notificationOperation?: React.ReactNode;
    /** The same start controller's pending/refusal, retained when its composer is dismissed. */
    runAgainStatus?: React.ReactNode;
    /**
     * Shown inside another pane (the Inbox's detail): the host pane is the pane, so the Run opens no
     * details column or right rail of its own, and its header is the title alone, like every other
     * detail there; the Run's controls follow in the body.
     */
    embedded?: boolean;
    /** The frozen definition this Run was admitted with, when it has been read. */
    definition: WorkflowDefinitionV1 | null;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    /** Accepted execution identities, never today's role or engine defaults. */
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    /** Frozen accepted-context fact, prepared by the Run read owner. */
    rolesChangedForRun?: boolean;
    inputs?: Readonly<Record<string, JsonValue>>;
    /** Names from the Session display owner for the accepted Run's observed executions. */
    sessionDisplayLabelsById?: ReadonlyMap<string, string>;
    /** A frozen source remains a source even after it is deleted. */
    hasSource?: boolean;
    /** Current source existence/access, resolved by the source owner. */
    sourceAction?: Readonly<{ kind: 'edit' | 'open'; onPress: () => void }> | null;
    /** The source action's access is still being checked: its slot is reserved, never drawn. */
    sourceActionPending?: boolean;
    /** Opens trigger editing for an editable saved source. */
    onAddTrigger?: () => void;
    invocations: readonly WorkflowRunInvocationIndexV1[];
    invocationsLoaded: boolean;
    /** True only after the unfiltered history cursor is exhausted. */
    invocationHistoryComplete: boolean;
    selectedInvocationId: string | null;
    onSelectInvocation: (invocationId: string) => void;
    /**
     * The canonical pane or exact phone page releases selection through the
     * same route owner that made it.
     */
    onDeselectInvocation?: () => void;
    onLoadMoreInvocations?: () => void;
    loadingMoreInvocations?: boolean;
    /**
     * The next page of that window could not be loaded. Loaded rows stay; this
     * only replaces the paging action with the reason and a Retry that asks for
     * exactly the same page again.
     */
    loadMoreInvocationsFailed?: boolean;
    onLoadMoreAttention?: () => void;
    loadingMoreAttention?: boolean;
    loadMoreAttentionFailed?: boolean;
    /** True while the attention cursor still has another page: the loaded count is partial, never a total. */
    attentionHasMore?: boolean;
    view: WorkflowRunDetailView;
    onChangeView: (view: WorkflowRunDetailView) => void;
    /** Present only when the canonical availability projection permits it. */
    onPause?: () => void;
    onResume?: () => void;
    onCancel?: () => void;
    /**
     * The durable operation the host submitted whose settlement is not yet
     * authoritative. Its own control names the request ("Stopping…"); every
     * other durable control is busy until it settles.
     */
    pendingControl?: WorkflowRunOperationKind | null;
    /**
     * A stop the canonical owner accepted and has not yet applied.
     *
     * This is durable intent, not transport lifetime: the server keeps an
     * admitted Run active while it marks its live invocations `cancel_requested`
     * and answers `intent: 'cancel_requested'`. Keyed to `pendingControl` the
     * label snapped back to **Stop** the moment the request returned, telling
     * the person to stop a Run that was already stopping.
     */
    cancelRequested?: boolean;
    /** Provider usage, or `null` when the provider supplied none. */
    usageLabel?: string | null;
    resultLabel?: string | null;
    result?: JsonValue;
    /** Exact final-output producer from the encrypted terminal result owner. */
    finalOutputInvocationId?: string | null;
    /** Earliest failed row from the lifecycle-indexed query owner. */
    firstFailedInvocationId: string | null;
    /** Whether the authoritative lifecycle-indexed failure query has settled. */
    firstFailedInvocationResolution: 'loading' | 'resolved' | 'error';
    /** Same exact cause, step identity and recovery facts consumed by See failures. */
    failurePresentation?: WorkflowRunFailurePresentation | null;
    selectedInvocationProgress?: WorkflowProgressEnvelopeV1 | null;
    /** The exact prior execution related to a human Wait, resolved by the Run read owner. */
    selectedRelatedExecution?: Readonly<{
        execution: NonNullable<WorkflowProgressEnvelopeV1['execution']>;
        canInspectExecution: boolean;
    }> | null;
    selectedInvocationRecoveryAvailability?: WorkflowInvocationRecoveryAvailabilityV1 | null;
    invocationProgressById?: ReadonlyMap<string, WorkflowProgressEnvelopeV1>;
    /**
     * Navigable identity for every loaded row, derived by the canonical
     * structure owner from the frozen definition plus the public index. The
     * host supplies it because it also announces selection; when a caller does
     * not, this body derives it through that same owner rather than inventing a
     * second mapping.
     */
    invocationStructure?: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    invocationStructureProjector?: ReturnType<typeof createWorkflowInvocationStructureProjector>;
    onOpenSession?: (sessionId: string) => void;
    onOpenExecutionRun?: (runId: string) => void;
    onRespondToRequest?: WorkflowInvocationDetailProps['onRespondToRequest'];
    /**
     * Requests whose answer the host has sent and not seen settle. Their
     * controls are withdrawn so an opposite press cannot race that answer.
     */
    pendingRequestIds?: ReadonlySet<string>;
    workspaceHomeDirectory?: string | null;
    onCopyWorkspace?: (directory: string) => void;
    onOpenWorkspace?: (workspaceRefId: string, directory: string) => void;
    onRetrySameConversation?: () => void;
    onRetryFreshAgent?: () => void;
    /** Repeat an Action or structural frame with its original input; it has no conversation to choose. */
    onRetry?: () => void;
    /** Repeat the selected attempt with an input the person reviewed instead of the original. */
    onRetryWithReplacement?: (input: WorkflowRecoveryContinuation) => void;
    onReattach?: () => void;
    /**
     * The continuation the execution owner already prepared for this attempt:
     * its objective, result contract and selected recorded context. Ordinary
     * recovery therefore needs no prompt reconstruction.
     *
     * The host projects this from the same opened progress this body projects
     * its recovery from, and supplies it so the host's decision to offer
     * `onContinuePrepared` and this body's presentation cannot disagree.
     */
    preparedRecovery?: WorkflowInvocationRecoveryV1 | null;
    onContinuePrepared?: (choice: WorkflowRecoveryContinuation) => void;
    /**
     * Whether this exact attempt's unknown prior effects have been acknowledged.
     * Continuation and retry stay refused until they are; no blanket consent
     * exists and the acknowledgement never survives a change of selection.
     */
    uncertaintyAcknowledged?: boolean;
    onAcknowledgeUncertainPriorEffects?: () => void;
    onStartReviewedNewRun?: () => void;
    onRunWithAnotherAgent?: () => void;
    onRestoreWorkspace?: () => void;
    onDelete?: () => void;
    onRunAgain?: () => void;
    /** Opens the Run's Machine at the page its failure's remedy names (administrator access, or its setup). */
    onOpenMachineRemedy?: (remedy: WorkflowFailureRemedy) => void;
    /** Starts the next round with the same participants and this round's results as context. */
    onAnotherRound?: () => void;
    /** Where the Run again composer anchors on wide layouts: the button itself, as Run now does. */
    runAgainAnchorRef?: React.RefObject<View | null>;
    onSaveAsWorkflow?: () => void;
    saveAsWorkflowPending?: boolean;
    deleteBlockedByCustody?: boolean;
    /**
     * Approvals this Run's result publication is waiting on (`useWorkflowRunPublicationRequests`). Each
     * opens that exact request; deciding it stays with the approval page, never with this Run.
     */
    publicationRequests?: readonly WorkflowRunPublicationRequest[];
    onOpenPublicationRequest?: (href: WorkflowRunPublicationRequest['href']) => void;
    /**
     * True only while this mounted instance is showing the completion moment it
     * observed. Its owner is `useWorkflowCompletionMoment`, which decides the
     * haptic and this emphasis together and resolves reduced motion to the
     * final semantic state with no emphasis at all.
     */
    completionEmphasis?: boolean;
    errorLabel?: string | null;
    /**
     * Whether `errorLabel` interrupts something the person just did or reports
     * something they are waiting on. It comes from the canonical Workflow
     * problem owner so a wait does not assertively interrupt a screen reader.
     */
    errorSemantics?: 'alert' | 'status';
    /** Re-run the screen's one canonical detail/index/attention load. */
    onReload?: () => void;
    reloadLabel?: string;
    selectedContentUnavailable?: boolean;
    /** The selected read has one presentation owner; Review takes placement when present. */
    selectedReadState?: React.ReactNode;
    contentContainerStyle?: StyleProp<ViewStyle>;
    testIDPrefix?: string;
}>;

/**
 * The phone review card, handed to the canonical modal owner over its exact step page.
 */
function WorkflowReviewCardModal(props: Readonly<{
    card: React.ReactNode;
    contentSized: boolean;
    headerActions?: React.ReactNode;
    headerTrailing?: React.ReactNode;
    subtitle: string | null;
}> & CustomModalInjectedProps): React.ReactElement {
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        scrollHost: props.contentSized ? 'overlay' as const : 'body' as const,
        bodyScroll: props.contentSized ? 'auto' as const : 'none' as const,
        actions: props.headerActions ?? null,
        subtitle: props.headerTrailing
            ? <View>{props.subtitle ? <Text style={styles.sheetSubtitle}>{props.subtitle}</Text> : null}{props.headerTrailing}</View>
            : props.subtitle,
    }), [props.contentSized, props.headerActions, props.headerTrailing, props.subtitle]));
    return <View style={[{ ...(props.contentSized ? {} : { flex: 1 }), minHeight: 0, minWidth: 0 }, styles.reviewSheet]}>{props.card}</View>;
}

/** The selected leaf's own Session grants decide Discuss; Run write access never grants chat. */
/** The modal body for a Run's quiet settings; the card's own close dismisses it. */
function RunDetailsSheet(props: Readonly<{ content: React.ReactNode }>): React.ReactElement {
    return <View style={styles.sheetBody}>{props.content}</View>;
}

function WorkflowSelectedDetail(props: Readonly<{
    detail: WorkflowInvocationDetailProps;
    sessionId: string | null;
    serverId?: string | null;
    active: boolean;
    phone: boolean;
    inlineHeader: boolean;
    title: string;
    subtitle: string | null;
    headerActions?: React.ReactNode;
    headerTrailing?: React.ReactNode;
    onClose?: () => void;
    identity: string;
    renderReviewCard?: WorkflowRunContentProps['renderReviewCard'];
    focusReturnRef: React.RefObject<FocusReturnTarget>;
}>): React.ReactElement | null {
    const source = useSessionInteractionSource(props.sessionId ?? '', props.serverId);
    const interaction = deriveTranscriptInteractionFromSession(source ?? {});
    const executeCommand = useKeyboardCommand();
    // A step shown on its own inside a host pane goes back to its run on the title line, when the host
    // hands one over (a Work peek); a page's own chrome otherwise owns Back.
    const BackControl = useNavigationBackControl();
    const layoutActive = useLayoutPresentationActive();
    const active = props.active && layoutActive;
    const [reviewDismissed, setReviewDismissed] = React.useState(false);
    const [focusRequested, setFocusRequested] = React.useState(false);
    const discuss = React.useCallback(() => {
        setReviewDismissed(true);
        setFocusRequested(true);
    }, []);
    const card = props.renderReviewCard?.(props.sessionId !== null && interaction.canSendMessages ? discuss : undefined,
        { compact: props.phone, title: props.title, subtitle: props.subtitle,
            // In a pane the facts scroll with the value, so the decision stays pinned under them.
            ...(props.phone ? {} : { belowResult: <WorkflowInvocationDetail {...props.detail} resultShownAbove /> }) }) ?? null;
    const reviewShown = card !== null && !reviewDismissed;
    const reviewOpen = props.phone && active && reviewShown;
    const paneHeaderScroll = usePaneHeaderScrollSink();
    const reportInspectorScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        paneHeaderScroll?.reportTopDistance(event.nativeEvent.contentOffset.y);
    }, [paneHeaderScroll]);
    useWorkflowCardModal({
        open: reviewOpen, component: WorkflowReviewCardModal,
        props: card === null ? null : { card, contentSized: props.detail.progress?.blockKind === 'wait',
            headerActions: props.headerActions, headerTrailing: props.headerTrailing, subtitle: props.subtitle }, identity: props.identity,
        title: props.title, subtitle: props.subtitle ?? undefined, testID: `${props.detail.testIDPrefix}-review-modal`,
        phonePresentation: 'sheet',
        focusReturnRef: props.focusReturnRef,
        onRequestClose: () => setReviewDismissed(true),
    });
    React.useEffect(() => {
        if (!focusRequested || reviewOpen || !active) return;
        executeCommand('composer.focus');
        setFocusRequested(false);
    }, [executeCommand, focusRequested, active, reviewOpen]);
    const reopenReview = reviewDismissed && card !== null ? <HappierPressable
        testID={`${props.detail.testIDPrefix}-open-review`} accessibilityRole="button"
        disabled={!active}
        onPress={() => setReviewDismissed(false)} style={[styles.actionTarget, styles.reopenReview]}>
        <Text style={styles.action}>{t('workflows.run.openReview')}</Text>
    </HappierPressable> : null;
    // A hold with no conversation belongs over the Run, not an empty step page.
    // Keep this owner mounted for sheet dismissal/reopening and draft continuity.
    if (props.phone && props.sessionId === null && card !== null) return reopenReview;
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {props.phone ? <PaneHeader testID={`${props.detail.testIDPrefix}-selected-header`}
            title={props.title} subtitle={props.subtitle} size="large" onClose={props.onClose}
            actions={reviewOpen ? undefined : props.headerActions} lineTrailing={reviewOpen ? undefined : props.headerTrailing} /> : null}
        {!props.phone && props.inlineHeader ? <DetailsTabHeader
            testID={`${props.detail.testIDPrefix}-selected-header`} title={props.title}
            leading={BackControl ? <BackControl style={null} /> : undefined}
            actions={props.headerActions} metaTrailing={props.headerTrailing}
            meta={props.subtitle ? [{ key: 'invocation', text: props.subtitle }] : undefined} /> : null}
        {reopenReview}
        {/* The held result stays bounded above its own conversation, with the composer at the pane's foot. */}
        {!props.phone && reviewShown ? <View testID={`${props.detail.testIDPrefix}-inspector`} accessibilityLabel={props.title}
            style={[props.sessionId === null ? styles.scroll : [styles.inspectorAboveConversation, styles.reviewAboveConversation], styles.reviewRegion]}>
            {card}
        </View> : <ScrollView testID={`${props.detail.testIDPrefix}-inspector`} accessibilityLabel={props.title}
            // The inspector is the body under the step's header: its scroll drives that header's shade.
            onScroll={paneHeaderScroll ? reportInspectorScroll : undefined} scrollEventThrottle={16}
            style={props.sessionId === null ? styles.scroll : styles.inspectorAboveConversation}
            contentContainerStyle={styles.inspectorContent}>
            <WorkflowInvocationDetail {...props.detail} />
        </ScrollView>}
        {props.sessionId === null ? null : <SessionInPane sessionId={props.sessionId}
            serverId={props.serverId} active={active && !reviewOpen} composer
            composerPlaceholder={t('workflows.run.stepComposerPlaceholder')} />}
    </View>;
}

/**
 * The paging control for this body's two inline paging sites.
 *
 * A continuation that failed is not a lost window: every row already read
 * stays, and only the action becomes its reason plus a Retry for exactly the
 * same page. A page in flight withdraws the action rather than letting a second
 * press ask again.
 */
function WorkflowRunPagingAction(props: Readonly<{
    testIDPrefix: string;
    onLoadMore: () => void;
    loading: boolean;
    failed: boolean;
}>): React.ReactElement {
    if (props.failed) {
        return (
            <View
                testID={`${props.testIDPrefix}-load-more-error`}
                accessibilityRole="alert"
                style={styles.section}
            >
                <Text style={styles.sectionLabel}>{t('workflows.loadFailedBody')}</Text>
                <HappierPressable
                    testID={`${props.testIDPrefix}-load-more-retry`}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.retry')}
                    disabled={props.loading}
                    onPress={props.onLoadMore}
                    style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
                >
                    <Text style={styles.action}>{t('workflows.retry')}</Text>
                </HappierPressable>
            </View>
        );
    }
    return (
        <HappierPressable
            testID={`${props.testIDPrefix}-load-more`}
            accessibilityRole="button"
            disabled={props.loading}
            onPress={props.onLoadMore}
            style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
        >
            <Text style={styles.action}>
                {props.loading ? t('common.loading') : t('workflows.run.loadMore')}
            </Text>
        </HappierPressable>
    );
}

export function WorkflowRunContent(props: WorkflowRunContentProps): React.ReactElement {
    const testIDPrefix = props.testIDPrefix ?? 'workflow-run';
    const { theme } = useUnistyles();
    const presentEngine = useRoleEnginePresentation();
    const [technicalOpen, setTechnicalOpen] = React.useState(false);
    const [notifyOpen, setNotifyOpen] = React.useState(false);
    const operationPending = props.pendingControl !== null && props.pendingControl !== undefined;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    /**
     * Wide layouts keep the selected detail in a neighbouring inspector beside
     * the outline; compact ones present it through the canonical modal (UX
     * §3.2, §4.5). Both read the same selection and the same reviewed buffers.
     */
    const sidePanesAvailable = useDetailsPaneAvailable();
    const detailsPaneAvailable = sidePanesAvailable && props.embedded !== true;
    const phone = useDeviceType() === 'phone';
    const navigationScope = useActiveServerAccountScope(props.serverId ?? null);
    const selectPage = React.useCallback((id: string) => {
        if (id === 'flow' || id === 'steps' || id === 'activity') props.onChangeView(id);
    }, [props.onChangeView]);
    const navigation = useWorkflowNavigation({ pageKind: 'workflowRun', identity: props.run.id, scope: navigationScope,
        activeId: props.view,
        phone, presented: props.active !== false,
        selectPage });
    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    // One identity for the page tabs, so live progress does not re-render them.
    const selectNavigation = React.useCallback((id: string) => selectWorkflowNavigationItem(executeNavigation, navigation.model, id),
        [executeNavigation, navigation.model]);
    /**
     * Where focus returns when the compact modal closes: the exact row or node
     * whose press selected the invocation. Recorded at the press, because by
     * the time the modal opens the selection has already moved.
     */
    const detailFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    const { onSelectInvocation } = props;
    const selectInvocation = React.useCallback((invocationId: string, event?: unknown) => {
        detailFocusReturnRef.current = readPressFocusReturnTarget(event);
        onSelectInvocation(invocationId);
    }, [onSelectInvocation]);
    /**
     * Half-written recovery text, owned above the selected detail.
     *
     * The buffers are keyed by the exact invocation, so they can never be shown
     * against a different attempt, and they outlive the detail's presentation:
     * a resize that moves the detail between the inspector and the modal, or a
     * Run change, cannot lose someone's own words. This is the one reviewed
     * buffer, not a second recovery store, and nothing here is persisted.
     */
    const [recoveryTextByInvocationId, setRecoveryTextByInvocationId] = React.useState<
        ReadonlyMap<string, Readonly<{ continuation?: string; replacement?: string }>>
    >(() => new Map());
    const selectedRecoveryText = props.selectedInvocationId === null
        ? undefined
        : recoveryTextByInvocationId.get(props.selectedInvocationId);
    const setSelectedRecoveryText = React.useCallback((
        field: 'continuation' | 'replacement',
        next: string,
    ) => {
        const invocationId = props.selectedInvocationId;
        if (invocationId === null) return;
        setRecoveryTextByInvocationId((current) => {
            const updated = new Map(current);
            updated.set(invocationId, { ...current.get(invocationId), [field]: next });
            return updated;
        });
    }, [props.selectedInvocationId]);
    const activityListRef = React.useRef<VirtualizedListRef | null>(null);
    const activityScrollOffsetRef = React.useRef(0);
    const flowScrollRef = React.useRef<ScrollView | null>(null);
    const flowScrollOffsetRef = React.useRef(0);
    const captureActivityScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        activityScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    }, []);
    const captureFlowScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        flowScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    }, []);
    React.useEffect(() => {
        if (props.view !== 'activity' || activityScrollOffsetRef.current <= 0) return;
        void activityListRef.current?.scrollToOffset({
            offset: activityScrollOffsetRef.current,
            animated: false,
        });
    }, [props.view]);
    React.useEffect(() => {
        if (props.view !== 'flow' || flowScrollOffsetRef.current <= 0) return;
        flowScrollRef.current?.scrollTo({
            y: flowScrollOffsetRef.current,
            animated: false,
        });
    }, [props.view]);
    const flowProjection = React.useMemo(
        () => (props.definition === null ? null : projectWorkflowFlow(props.definition, props.frozenChildren, undefined, { presentation: 'run' })),
        [props.definition, props.frozenChildren],
    );
    const structureProgressById = React.useMemo(() => {
        if (props.selectedInvocationId === null || props.selectedInvocationProgress == null) return props.invocationProgressById;
        if (props.invocationProgressById?.get(props.selectedInvocationId) === props.selectedInvocationProgress) return props.invocationProgressById;
        const progress = new Map(props.invocationProgressById);
        progress.set(props.selectedInvocationId, props.selectedInvocationProgress);
        return progress;
    }, [props.invocationProgressById, props.selectedInvocationId, props.selectedInvocationProgress]);
    const structureProjector = React.useMemo(() => props.invocationStructureProjector
        ?? createWorkflowInvocationStructureProjector({ definition: props.definition,
            frozenChildren: props.frozenChildren, materializedLeaves: props.materializedLeaves,
            inputs: props.inputs, serverId: props.serverId }),
    [props.invocationStructureProjector, props.definition, props.frozenChildren, props.materializedLeaves, props.inputs, props.serverId]);
    const derivedStructure = React.useMemo(
        () => (props.invocationStructure !== undefined
            ? props.invocationStructure
            : structureProjector({
                invocations: props.invocations,
                ...(structureProgressById === undefined
                    ? {}
                    : { progressByInvocationId: structureProgressById }),
            })),
        [structureProjector, structureProgressById, props.invocationStructure, props.invocations],
    );
    const attentionRows = React.useMemo(
        () => props.invocations.filter((entry) => isWorkflowAttentionInvocation(entry.lifecycle, derivedStructure.get(entry.id)?.coverageKind, props.run.state, props.cancelRequested)),
        [derivedStructure, props.invocations, props.run.state, props.cancelRequested],
    );
    const attentionCount = attentionRows.length;
    const approvalPresentation = React.useMemo(() => selectWorkflowRunApprovalPresentation({
        requests: props.publicationRequests ?? [], waitingInvocations: attentionRows,
        progressByInvocationId: structureProgressById,
    }), [props.publicationRequests, attentionRows, structureProgressById]);
    // The index draws one row per held step: a For-each's held items share it, ordered as the items
    // are (item 1 first, whatever order they were dispatched in), and its Review opens the first.
    const attentionIndexRows = React.useMemo(() => {
        type IndexRow = { invocation: WorkflowRunInvocationIndexV1; members: WorkflowRunInvocationIndexV1[] };
        const rows: IndexRow[] = [];
        const byNode = new Map<string, IndexRow>();
        const occurrenceOf = (invocation: WorkflowRunInvocationIndexV1) => derivedStructure.get(invocation.id)?.occurrence ?? [];
        for (const invocation of attentionRows) {
            const nodeId = derivedStructure.get(invocation.id)?.nodeId ?? null;
            const repeated = occurrenceOf(invocation).some((coordinate) => coordinate.kind === 'item' || coordinate.kind === 'iteration');
            // Distinct approval decisions each keep their exact Open request entry.
            const repeatedNodeId = nodeId !== null && repeated && !approvalPresentation.byInvocationId.has(invocation.id) ? nodeId : null;
            const existing = repeatedNodeId === null ? undefined : byNode.get(repeatedNodeId);
            if (existing) {
                existing.members.push(invocation);
                continue;
            }
            const row: IndexRow = { invocation, members: [invocation] };
            rows.push(row);
            if (repeatedNodeId !== null) byNode.set(repeatedNodeId, row);
        }
        for (const row of rows) {
            if (row.members.length < 2) continue;
            row.members.sort((a, b) => compareWorkflowOccurrences(occurrenceOf(a), occurrenceOf(b)));
            row.invocation = row.members[0] ?? row.invocation;
        }
        return rows;
    }, [attentionRows, derivedStructure, approvalPresentation.byInvocationId]);
    /**
     * Activity lists the work inside the Run. The Run's own root row repeats what the header and
     * outcome already say, and Map and Steps never show it either.
     */
    const activityInvocations = React.useMemo(
        // The visible window leads with held rows for Needs you; a log reads in the order the work ran.
        () => props.invocations.filter((invocation) => derivedStructure.get(invocation.id)?.blockId !== '$root').sort(compareInvocationOrder),
        [derivedStructure, props.invocations],
    );
    const coverage = React.useMemo(() => summarizeWorkflowInvocationCoverage(props.invocations, {
        kindsByInvocationId: new Map([...derivedStructure].map(([id, entry]) => [id, entry.coverageKind])),
        historyComplete: props.invocationsLoaded && props.invocationHistoryComplete,
        runState: props.run.state,
        cancelRequested: props.cancelRequested,
        knownFailure: props.firstFailedInvocationId != null,
    }), [derivedStructure, props.firstFailedInvocationId, props.invocationHistoryComplete, props.invocations, props.invocationsLoaded, props.run.state, props.cancelRequested]);

    /**
     * Row identity comes from the authored definition, not from whether the
     * private detail has already been opened. A row the frozen definition
     * cannot place keeps the explicit unavailable treatment; the structural
     * root frame says what it is rather than borrowing that phrase.
     */
    const invocationLabel = React.useCallback((invocation: WorkflowRunInvocationIndexV1): string | null => {
        const entry = derivedStructure.get(invocation.id);
        if (entry === undefined) return null;
        if (entry.nodeId !== null && flowProjection !== null) {
            const node = flowProjection.nodesById.get(entry.nodeId);
            if (node !== undefined) return node.label;
        }
        return entry.blockId === '$root' ? t('workflows.run.untitled') : null;
    }, [derivedStructure, flowProjection]);

    /**
     * Where one occurrence sits, in words: lane, nested workflow, item or round. The Map already
     * draws the lane and nesting around its node, so it asks only for the repetition (`Item 2`).
     */
    const formatOccurrence = React.useCallback((
        occurrence: readonly WorkflowOccurrenceCoordinate[],
        scope: 'full' | 'repetition' = 'full',
    ): string | undefined => {
        return formatWorkflowOccurrenceLabel(occurrence, flowProjection, scope);
    }, [flowProjection]);
    const formatMapOccurrence = React.useCallback((occurrence: readonly WorkflowOccurrenceCoordinate[]) => (
        formatOccurrence(occurrence, 'repetition')
    ), [formatOccurrence]);
    const invocationOccurrenceLabel = React.useCallback((invocation: WorkflowRunInvocationIndexV1) => (
        formatOccurrence(derivedStructure.get(invocation.id)?.occurrence ?? []) ?? null
    ), [derivedStructure, formatOccurrence]);
    /** A top-level step's mark is the Agent its accepted selection names, never today's default. */
    const agentMarkForNode = React.useCallback((node: { nodeId: string; blockId: string }): React.ReactNode | null => {
        if (node.nodeId !== node.blockId) return null;
        const agentTarget = props.materializedLeaves?.find((leaf) => leaf.sourceKey === '$root' && leaf.blockId === node.blockId)
            ?.selection.agentTarget;
        return agentTarget == null ? null : presentEngine({ agentTargetKey: resolveBackendTargetKeyV2(agentTarget) }, ICON_SIZE.sm).icon;
    }, [presentEngine, props.materializedLeaves]);
    const overflowActions = React.useMemo((): ItemAction[] => {
        const actions: ItemAction[] = [];
        if (props.hasSource === true && props.onSaveAsWorkflow !== undefined) actions.push({
            id: `${testIDPrefix}-save-as-workflow`,
            title: t('workflows.run.saveAsNewWorkflow'),
            icon: 'copy',
            disabled: props.saveAsWorkflowPending === true,
            onPress: props.onSaveAsWorkflow,
        });
        if (props.onAddTrigger !== undefined) actions.push({
            id: `${testIDPrefix}-add-trigger`,
            title: t('workflows.run.addTrigger'),
            icon: 'clock',
            onPress: props.onAddTrigger,
        });
        // Observation preferences and ids are rare: the page's composition is the outcome and what needs
        // the person, so they live behind ⋯ (lab run-A has neither at the page's foot).
        if (props.notificationOperation != null) actions.push({
            id: `${testIDPrefix}-notifications`,
            title: t('sessionWork.notify.setup'),
            icon: 'bell',
            onPress: () => setNotifyOpen(true),
        });
        actions.push({
            id: `${testIDPrefix}-technical-toggle`,
            title: t('workflows.run.technicalDetails'),
            icon: 'info',
            selected: technicalOpen,
            onPress: () => setTechnicalOpen((open) => !open),
        });
        if (props.onDelete !== undefined) actions.push({
            id: `${testIDPrefix}-delete-history`,
            title: t('workflows.run.deleteHistory'),
            icon: 'trash',
            destructive: true,
            disabled: operationPending,
            onPress: props.onDelete,
        });
        return actions;
    }, [
        operationPending,
        props.hasSource,
        props.notificationOperation,
        props.onDelete,
        props.onSaveAsWorkflow,
        props.onAddTrigger,
        props.saveAsWorkflowPending,
        technicalOpen,
        testIDPrefix,
    ]);
    const flowRunStates = React.useMemo(() => {
        if ((props.view !== 'flow' && props.view !== 'steps') || flowProjection === null) return undefined;
        // Which authored node a row belongs to is the structure owner's answer,
        // so an occurrence stays selectable before its private detail has ever
        // been opened.
        return projectWorkflowFlowRunStates({
            invocations: props.invocations,
            structure: derivedStructure,
            progressByInvocationId: structureProgressById,
            projection: flowProjection,
            formatOccurrence: formatMapOccurrence,
        });
    }, [derivedStructure, flowProjection, formatMapOccurrence, props.invocations, props.view, structureProgressById]);

    /**
     * The terminal primary action (UX §3.3).
     *
     * Both arms navigate to an exact invocation the canonical structure owner
     * already resolved — the authored `finalOutput` producer, or the first
     * failed row — rather than to "the latest row". When the Run is terminal and
     * no selected final result exists, the absence is stated instead of implied.
     */
    const stopPending = isWorkflowRunStopPending({ ...props.run, cancelRequested: props.cancelRequested });
    const canResume = canResumeWorkflowRunBoundary({ run: props.run, canEdit: props.onResume !== undefined });
    const setupMachine = React.useMemo(() => (props.machineName ? { id: props.run.machineId, name: props.machineName } : null),
        [props.machineName, props.run.machineId]);
    const invocationStatusContext = React.useMemo(() => ({ runStopPending: stopPending,
        machineReachable: props.machineReachable, machineName: props.machineName ?? props.run.machineId }),
    [stopPending, props.machineReachable, props.machineName, props.run.machineId]);
    const terminalOutcome = React.useMemo((): Readonly<{
        kind: 'open_result'; invocationId: string;
    } | {
        kind: 'see_failures'; invocationId: string;
    } | {
        kind: 'result_absent';
    }> | null => {
        if (!isTerminalWorkflowRunState(props.run.state)) return null;
        // A Stop still being carried out is not an outcome yet: no settled-Run actions beside it (DESIGN-17 R2).
        if (stopPending) return null;
        if (props.firstFailedInvocationResolution !== 'resolved') return null;
        if (props.firstFailedInvocationId !== null) {
            return { kind: 'see_failures', invocationId: props.failurePresentation?.invocationId
                ?? selectWorkflowRunFailureInvocation({ invocations: props.invocations, structure: derivedStructure,
                    firstFailedInvocationId: props.firstFailedInvocationId })?.id ?? props.firstFailedInvocationId };
        }
        if (props.run.state === 'failed') return null;
        // Only a Run that finished has a result to open or steps to inspect as its answer; a stopped,
        // expired or uncertain Run leads with its own recovery (07 §6.1), never Inspect steps.
        if (props.run.state !== 'succeeded') return null;
        const producerBlockId = props.definition?.finalOutput?.producer.blockId ?? null;
        if (producerBlockId === null
            || props.resultLabel === null
            || props.resultLabel === undefined) return { kind: 'result_absent' };
        // The producing row is a fact the canonical Run owner reports with the
        // result; this consumer opens exactly that row. Deriving it from history
        // would pick an attempt nobody selected — a retried step has several
        // completed rows for one block — so its absence leaves the outcome
        // without a navigation action rather than pointing somewhere plausible.
        return props.finalOutputInvocationId === undefined || props.finalOutputInvocationId === null
            ? null
            : { kind: 'open_result', invocationId: props.finalOutputInvocationId };
    }, [derivedStructure, props.definition, props.failurePresentation, props.finalOutputInvocationId, props.firstFailedInvocationId, props.firstFailedInvocationResolution, props.invocations, props.resultLabel, props.run.state, stopPending]);

    // A terminal Run's actions and primary depend on its first failure (See failures leads, or Run again).
    // That lookup settles after the page, so until then none is offered: the outcome is decided once, and
    // nothing arrives, swaps or changes tone after the page is read (an interrupted Run's primary never
    // depends on it, so only its cause line waits).
    const outcomeUndecided = isTerminalWorkflowRunState(props.run.state) && !stopPending
        && props.firstFailedInvocationResolution === 'loading';
    const onResume = outcomeUndecided ? undefined : props.onResume;
    const onRunAgain = outcomeUndecided ? undefined : props.onRunAgain;
    const onAnotherRound = outcomeUndecided ? undefined : props.onAnotherRound;


    /** The row's authored block kind, from the frozen definition through the structure owner. */
    const invocationBlockKind = React.useCallback((invocation: WorkflowRunInvocationIndexV1): string | null => {
        const nodeId = derivedStructure.get(invocation.id)?.nodeId ?? null;
        return nodeId === null ? null : flowProjection?.nodesById.get(nodeId)?.kind ?? null;
    }, [derivedStructure, flowProjection]);
    const activityPresentation = React.useMemo(() => ({
        scope: navigationScope,
        definition: props.definition,
        projection: flowProjection,
        project: structureProjector,
    }), [navigationScope, props.definition, flowProjection, structureProjector]);
    const attentionWaitsForYou = React.useCallback((invocation: WorkflowRunInvocationIndexV1) => (
        isWorkflowWaitForYouHold(invocation.lifecycle, { blockKind: invocationBlockKind(invocation) })
    ), [invocationBlockKind]);
    const firstAttention = attentionRows[0];
    // One primary per view: while a hold is open beside the Run, its own card carries the primary,
    // so the index's Review stays bordered; with nothing open, the first hold is the page's next step.
    // A phone page keeps what needs you in a dock in thumb reach instead of a section above the Map (phone-P1).
    const phoneDock = phone && props.embedded !== true && attentionIndexRows.length > 0;
    const [dockHeightPx, setDockHeightPx] = React.useState(0);
    // The page ends above the phone's floating bottom chrome instead of under it.
    const chromeClearance = useFloatingChromeClearance();
    const firstAttentionLabel = firstAttention === undefined ? null : invocationLabel(firstAttention);
    const firstAttentionOccurrence = firstAttention === undefined ? null : invocationOccurrenceLabel(firstAttention);
    const failureInvocation = props.firstFailedInvocationResolution === 'resolved'
        ? selectWorkflowRunFailureInvocation({ invocations: props.invocations, structure: derivedStructure,
            firstFailedInvocationId: props.firstFailedInvocationId, runState: props.run.state }) ?? firstAttention ?? null
        : null;
    const failurePresentation = React.useMemo(() => props.failurePresentation !== undefined ? props.failurePresentation
        : projectWorkflowRunFailure({
            run: props.run, invocation: failureInvocation,
            progress: failureInvocation === null ? null : structureProgressById?.get(failureInvocation.id) ?? null,
            recoveryAvailability: failureInvocation?.id === props.selectedInvocationId ? props.selectedInvocationRecoveryAvailability : null,
            structure: derivedStructure, projection: flowProjection,
            machineHomeDirectory: props.workspaceHomeDirectory ?? null,
            ...(props.machineReachable === undefined ? {} : { machine: { name: props.machineName ?? props.run.machineId,
                reachable: props.machineReachable, lastSeenAt: props.machineLastSeenAt ?? null } }),
            invocations: props.invocations, invocationHistoryComplete: props.invocationHistoryComplete,
        }), [props.failurePresentation, props.run, failureInvocation, structureProgressById, props.selectedInvocationId,
            props.selectedInvocationRecoveryAvailability, derivedStructure, flowProjection, props.workspaceHomeDirectory,
            props.machineReachable, props.machineName, props.machineLastSeenAt, props.invocations, props.invocationHistoryComplete]);
    // One dominant action per state (UX §1, §3.3): the lifecycle owner resolves it, every other eligible
    // action stays secondary. A failed Run leads with Run again next to its failure, or with the Machine
    // setting its typed refusal names when running again unchanged would fail the same way.
    const failureRemedy = props.run.state === 'failed' && props.onOpenMachineRemedy !== undefined
        ? failurePresentation?.recovery.remedy ?? null : null;
    const primaryAction = resolveWorkflowRunPrimaryAction({
        state: props.run.state,
        terminalOutcome: terminalOutcome?.kind ?? null,
        canResume,
        canRunAgain: onRunAgain !== undefined,
        canStop: props.run.availability.cancel && props.onCancel !== undefined && props.cancelRequested !== true,
        remedy: failureRemedy,
    });
    // The failure is already open beside the Run: its step carries the way forward as the pane's primary, so
    // the header's stays visible but bordered, and See failures would only point at the step already showing.
    const failureOpen = terminalOutcome?.kind === 'see_failures'
        && props.selectedInvocationId === terminalOutcome.invocationId;
    // One primary per page: the first hold's Review leads only when the header has no primary of its own.
    const primaryReviewId = props.selectedInvocationId === null && primaryAction === null
        ? attentionIndexRows[0]?.invocation.id : undefined;
    const failedStepLabel = props.run.state === 'failed' || props.run.state === 'interrupted'
        ? failurePresentation?.step?.name ?? null : null;
    // The Run keeps its cause visible while the selected step is inspected beside it.
    // The line names the failed step's number, what the attempt recorded
    // and a usage limit's reset, so the page says why without opening See failures (FIN-DESIGN-C4 R5).
    // An interrupted Run parked on a failed step says the same retained cause under its status.
    const runProblem = failurePresentation == null ? resolveWorkflowRunProblemPresentation(props.run) : null;
    const failureReason = runProblem?.message ?? ((props.run.state !== 'failed' && props.run.state !== 'interrupted') || failurePresentation == null ? null
        : formatWorkflowRunFailureCauseLine(failurePresentation));
    const failureReasonPending = failureReason === null
        && (props.run.state === 'failed' || props.run.state === 'interrupted')
        && props.firstFailedInvocationResolution === 'loading' && (phone || props.selectedInvocationId === null);
    const failureRecoveryInstruction = failurePresentation?.recovery.usageLimitWait
        ?? (failurePresentation !== null && primaryAction === 'stop' && resolveWorkflowRecoveryChoices(failurePresentation.recovery, props).noChoices
            ? t('workflows.recovery.nextStop') : null);
    const outcomeWord = formatWorkflowRunOutcomeLabel({
        state: props.run.state,
        workflowCustodyState: props.run.workflowCustodyState,
        cancelRequested: props.cancelRequested,
        machineReachable: props.machineReachable,
        machineName: props.machineName ?? props.run.machineId,
        coverage,
        historyComplete: props.invocationHistoryComplete,
        inAttentionWindow: props.run.attentionRequired === true || attentionRows.length > 0,
        waitingOnlyForYou: attentionRows.length > 0 ? attentionRows.every(attentionWaitsForYou) : undefined,
    });
    const consequence = React.useMemo(() => formatWorkflowRunConsequenceSentence({
        run: props.run,
        definition: props.definition,
        frozenChildren: props.frozenChildren,
        invocations: props.invocations,
        structure: derivedStructure,
        historyComplete: props.invocationsLoaded && props.invocationHistoryComplete,
        machineReachable: props.machineReachable,
    }), [derivedStructure, props.definition, props.frozenChildren, props.invocationHistoryComplete, props.invocations,
        props.invocationsLoaded, props.machineReachable, props.run]);
    const outcomeFailed = describeWorkflowRunState(props.run.state).variant === 'danger'
        || (props.run.state === 'succeeded' && coverage.knownFailure);
    // A Run made only of Machine setup steps says what they installed instead of counting steps.
    const runSetupOutcome = React.useMemo(() => {
        if (props.definition === null) return null;
        const leaves = walkWorkflowBlocks(props.definition.blocks).filter((block) => block.kind === 'action'
            || block.kind === 'step' || block.kind === 'wait' || block.kind === 'workflow');
        return leaves.every((block) => block.kind === 'action')
            ? describeWorkflowSetupOutcome({ blocks: leaves.flatMap((block) => (block.kind === 'action' ? [block] : [])),
                machine: setupMachine })
            : null;
    }, [props.definition, setupMachine]);
    const runningInvocation = props.run.state === 'running' && firstAttention === undefined
        ? activityInvocations.find(invocation => invocation.lifecycle === 'running'
            && derivedStructure.get(invocation.id)?.coverageKind === 'executable')
        : undefined;
    const runningStep = runningInvocation === undefined ? null : invocationLabel(runningInvocation);
    const runningOccurrence = runningInvocation === undefined ? null : invocationOccurrenceLabel(runningInvocation);
    const outcomeLine = formatWorkflowRunOutcomeLine({
        word: outcomeWord,
        sentence: formatWorkflowRunOutcomeSentence({
            run: props.run,
            cancelRequested: props.cancelRequested,
            coverage,
            historyComplete: props.invocationHistoryComplete,
            failure: failedStepLabel === null ? null : { step: failedStepLabel, lifecycle: failurePresentation?.invocationLifecycle },
            setup: runSetupOutcome,
            runningStep: runningStep === null ? null : runningOccurrence === null ? runningStep : `${runningStep} · ${runningOccurrence}`,
            attention: firstAttention === undefined || firstAttentionLabel === null ? null : {
                step: firstAttentionOccurrence === null ? firstAttentionLabel : `${firstAttentionLabel} · ${firstAttentionOccurrence}`,
                waitForYou: attentionWaitsForYou(firstAttention),
                waitsForApproval: firstAttention.lifecycle === 'waiting_for_approval',
                reviewCount: props.run.state === 'waiting_for_review' && firstAttention.lifecycle === 'waiting_for_review'
                    && coverage.coverage === 'complete'
                    ? attentionRows.reduce((count, row) => count + (row.lifecycle === 'waiting_for_review' && !attentionWaitsForYou(row) ? 1 : 0), 0)
                    : undefined,
            },
            ...(props.machineReachable === undefined ? {} : {
                machine: {
                    name: props.machineName ?? props.run.machineId,
                    reachable: props.machineReachable,
                    status: props.machineStatus,
                },
            }),
        }),
    });
    const startedAtMs = Date.parse(props.run.createdAt);
    // Only the server's own terminal-transition instant ends the range; `updatedAt` also moves for
    // later custody and delivery bookkeeping, so it never stands in for a finish.
    const finishedAtMs = props.run.finishedAt == null ? Number.NaN : Date.parse(props.run.finishedAt);
    const originLabel = formatWorkflowRunOriginLabel(props.run.origin);
    const sourceSessionId = props.run.origin.kind === 'direct'
        ? props.run.origin.originSessionId ?? null
        : null;
    const onOpenSession = props.onOpenSession;
    // "From a session" is itself the way back to that session; the page never repeats it as a second line.
    const openOrigin = React.useMemo(() => sourceSessionId === null || onOpenSession === undefined ? undefined
        : () => onOpenSession(sourceSessionId), [onOpenSession, sourceSessionId]);
    const headerMeta = React.useMemo((): PageHeaderMetaFact[] => [
        // A Run you started yourself is the default and says nothing; a schedule or a session is
        // the distinguishing fact. "Started directly · … · Started 12:00" said "started" twice.
        ...(props.run.origin.kind === 'direct' && !props.run.origin.originSessionId ? []
            : [{ key: 'origin', text: originLabel, icon: 'tree-structure' as const, testID: `${testIDPrefix}-origin`,
                ...(openOrigin === undefined ? {} : { onPress: openOrigin, accessibilityLabel: t('workflows.run.openSourceSession') }) }]),
        ...(props.machineName ? [{ key: 'machine', text: props.machineName, icon: 'desktop' as const }] : []),
        ...(!Number.isFinite(startedAtMs) ? [] : Number.isFinite(finishedAtMs)
            // The end is read against the start: a same-day range names its day once ("Oct 11, 17:56 – 18:54").
            ? [{ key: 'time', text: t('workflows.run.timeRange', { start: formatAsOfTime(startedAtMs), end: formatAsOfTime(finishedAtMs, startedAtMs) }) }]
            : [{ key: 'time', text: t('workflows.run.startedAt', { time: formatAsOfTime(startedAtMs) }) }]),
        ...(props.rolesChangedForRun ? [{ key: 'roles', text: t('workflows.run.rolesChangedForRun') }] : []),
    ], [finishedAtMs, openOrigin, originLabel, props.machineName, props.rolesChangedForRun, startedAtMs, testIDPrefix]);
    const embeddedHeaderMeta = React.useMemo(
        () => headerMeta.map((fact) => ({ key: fact.key, text: fact.text, ...(fact.testID === undefined ? {} : { testID: fact.testID }) })),
        [headerMeta],
    );
    const selectedInvocation = props.selectedInvocationId === null
        ? null
        : props.invocations.find((invocation) => invocation.id === props.selectedInvocationId) ?? null;
    const currentWork = React.useMemo(() => {
        if (isTerminalWorkflowRunState(props.run.state)) return null;
        const executableRows = props.invocations.filter((row) => derivedStructure.get(row.id)?.coverageKind === 'executable');
        return executableRows.find((row) => isWorkflowAttentionInvocation(row.lifecycle, derivedStructure.get(row.id)?.coverageKind, props.run.state, props.cancelRequested))
            ?? executableRows.find((row) => describeWorkflowInvocationLifecycle(row.lifecycle).marker.kind === 'activity')
            ?? null;
    }, [derivedStructure, props.invocations, props.run.state, props.cancelRequested]);
    const recovery = React.useMemo(() => {
        const projected = selectedInvocation !== null && selectedInvocation.id === failurePresentation?.invocationId
            ? failurePresentation.recovery : projectWorkflowInvocationRecovery({
            run: props.run,
            invocation: selectedInvocation,
            progress: props.selectedInvocationProgress ?? null,
            recoveryAvailability: props.selectedInvocationRecoveryAvailability ?? null,
            ...(props.machineReachable === undefined ? {} : { machine: {
                name: props.machineName ?? props.run.machineId, reachable: props.machineReachable,
                lastSeenAt: props.machineLastSeenAt ?? null,
            } }),
            machineHomeDirectory: props.workspaceHomeDirectory ?? null,
            invocations: props.invocations,
            invocationHistoryComplete: props.invocationHistoryComplete,
        });
        return props.preparedRecovery === undefined || props.preparedRecovery === projected.preparedRecovery
            ? projected
            : { ...projected, preparedRecovery: props.preparedRecovery };
    }, [failurePresentation, props.invocationHistoryComplete, props.invocations, props.machineLastSeenAt, props.machineName, props.machineReachable, props.preparedRecovery, props.run, selectedInvocation, props.selectedInvocationProgress, props.selectedInvocationRecoveryAvailability, props.workspaceHomeDirectory]);
    const selectedWorkspace = recovery.workspace;
    const workspaceSourceBlockLabel = selectedWorkspace?.sourceBlockId === null
        || selectedWorkspace?.sourceBlockId === undefined
        ? null
        : flowProjection?.nodesById.get(selectedWorkspace.sourceBlockId)?.label
            ?? selectedWorkspace.sourceBlockId;
    const selectedNodeId = props.selectedInvocationId === null ? null : derivedStructure.get(props.selectedInvocationId)?.nodeId ?? null;
    const selectedInvocationCause = describeWorkflowInvocationCause({
        lifecycle: selectedInvocation?.lifecycle ?? null,
        reasonCode: props.selectedInvocationProgress?.reason?.code ?? null,
        reasonDetails: props.selectedInvocationProgress?.reason?.details,
        blockLabel: selectedNodeId === null ? null : flowProjection?.nodesById.get(selectedNodeId)?.label ?? null,
        blockKind: props.selectedInvocationProgress?.blockKind,
    });
    const workspaceSourceLabel = workspaceSourceBlockLabel === null
        ? null
        : formatWorkflowWorkspaceSourceLabel(
            workspaceSourceBlockLabel,
            selectedWorkspace?.sourceInvocationRecordId ?? null,
        );

    /**
     * The state's actions sit in the header beside the Run's own controls (lab run-A): secondary
     * ones first, the one primary last before `⋯`. On a phone page they wrap under the outcome, so
     * the primary leads there instead of landing alone on the second line. Inspect steps is withdrawn
     * while Steps is open, since it would only point at the view already showing.
     */
    // Beside an open failure the pane's own Run again is the primary, so the header keeps its one bordered.
    const headerPrimaryAction = (primaryAction === 'run_again' || primaryAction === 'remedy')
        && (failureOpen && detailsPaneAvailable || failurePresentation?.recovery.repairGuidance != null) ? null : primaryAction;
    const onOpenMachineRemedy = props.onOpenMachineRemedy;
    const remedyAction = primaryAction === 'remedy' && failureRemedy !== null && onOpenMachineRemedy !== undefined ? (
        <ToolbarButton
            key="remedy"
            testID={`${testIDPrefix}-remedy-${failureRemedy}`}
            onPress={() => onOpenMachineRemedy(failureRemedy)}
            label={formatWorkflowFailureRemedyLabel(failureRemedy)}
            {...(headerPrimaryAction === 'remedy' ? { tone: 'primary' as const } : {})}
            size="md"
        />
    ) : null;
    const resumeAction = canResume ? (
        <ToolbarButton
            key="resume"
            testID={`${testIDPrefix}-resume`}
            disabled={operationPending}
            busy={operationPending}
            onPress={onResume}
            label={t('workflows.run.resume')}
            {...(primaryAction === 'resume' ? { tone: 'primary' as const } : {})}
            size="md"
        />
    ) : null;
    const runAgainAction = onRunAgain !== undefined ? (
        <View key="run-again" ref={props.runAgainAnchorRef} collapsable={false}>
            <ToolbarButton
                testID={`${testIDPrefix}-run-again`}
                onPress={onRunAgain}
                label={t('workflows.run.runAgain')}
                {...(headerPrimaryAction === 'run_again' ? { tone: 'primary' as const } : {})}
                size="md"
            />
        </View>
    ) : null;
    const anotherRoundAction = onAnotherRound !== undefined ? (
        <ToolbarButton
            key="another-round"
            testID={`${testIDPrefix}-another-round`}
            disabled={operationPending}
            onPress={onAnotherRound}
            label={t('workflows.start.anotherRound')}
            size="md"
        />
    ) : null;
    const outcomeAction = terminalOutcome?.kind === 'result_absent' && props.view !== 'steps' ? (
        <ToolbarButton
            key="inspect-steps"
            testID={`${testIDPrefix}-inspect-steps`}
            onPress={() => selectWorkflowNavigationItem(executeNavigation, navigation.model, 'steps')}
            label={t('workflows.run.inspectSteps')}
            size="md"
        />
    ) : terminalOutcome?.kind === 'open_result' ? (
        <ToolbarButton
            key="open-result"
            testID={`${testIDPrefix}-open-result`}
            onPress={(event) => selectInvocation(terminalOutcome.invocationId, event)}
            label={t('workflows.run.openResult')}
            tone="primary"
            size="md"
        />
    ) : terminalOutcome?.kind === 'see_failures' && !failureOpen ? (
        <ToolbarButton
            key="see-failures"
            testID={`${testIDPrefix}-see-failures`}
            onPress={(event) => selectInvocation(terminalOutcome.invocationId, event)}
            label={t('workflows.run.seeFailures')}
            {...(headerPrimaryAction === 'outcome' ? { tone: 'primary' as const } : {})}
            size="md"
        />
    ) : null;
    const primaryElement = headerPrimaryAction === 'outcome' ? outcomeAction
        : headerPrimaryAction === 'resume' ? resumeAction
            : headerPrimaryAction === 'run_again' ? runAgainAction
                : headerPrimaryAction === 'remedy' ? remedyAction : null;
    const phonePage = phone && props.embedded !== true;
    // One primary in the page (lab P1). On a phone page, and beside an open details pane where the header has a
    // narrow column, Run again and Another round fold into `⋯` unless one of them is the state's primary; a
    // phone page folds Open workflow there too, so no lone bordered button sits under the view switch.
    // `detailsPaneAvailable` already excludes an embedded Run.
    const compactActions = phonePage || (detailsPaneAvailable && props.selectedInvocationId !== null);
    // A failed Run's Run again never folds: it is the way forward, so it stays in reach beside the failure.
    const runAgainFolded = compactActions && runAgainAction !== null && primaryAction !== 'run_again';
    const anotherRoundFolded = compactActions && anotherRoundAction !== null;
    const secondaryElements = [resumeAction, runAgainFolded ? null : runAgainAction, anotherRoundFolded ? null : anotherRoundAction, outcomeAction,
        remedyAction]
        .filter((element) => element !== null && element !== primaryElement);
    const sourceFolded = phonePage;
    const stateMenuActions: ItemAction[] = [
        ...(runAgainFolded && onRunAgain ? [{ id: `${testIDPrefix}-run-again`, title: t('workflows.run.runAgain'),
            icon: 'play' as const, onPress: onRunAgain }] : []),
        ...(anotherRoundFolded && onAnotherRound ? [{ id: `${testIDPrefix}-another-round`, title: t('workflows.start.anotherRound'),
            icon: 'arrows-clockwise' as const, disabled: operationPending, onPress: onAnotherRound }] : []),
        ...(sourceFolded && props.sourceAction ? [{ id: `${testIDPrefix}-${props.sourceAction.kind}-workflow`,
            title: props.sourceAction.kind === 'edit' ? t('workflows.run.editWorkflow') : t('workflows.run.openWorkflow'),
            icon: props.sourceAction.kind === 'edit' ? 'pencil-simple' as const : 'tree-structure' as const,
            onPress: props.sourceAction.onPress }] : []),
        ...(sourceFolded && !props.sourceAction && props.sourceActionPending !== true && props.hasSource !== true && props.onSaveAsWorkflow ? [{ id: `${testIDPrefix}-save-as-workflow`,
            title: t('workflows.run.saveAsWorkflow'), icon: 'copy' as const, disabled: props.saveAsWorkflowPending === true,
            onPress: props.onSaveAsWorkflow }] : []),
    ];
    const menuActions = stateMenuActions.length === 0 ? overflowActions : [...stateMenuActions, ...overflowActions];
    const outcomeActions = (
        <>{phonePage ? [primaryElement, ...secondaryElements] : [...secondaryElements, primaryElement]}</>
    );

    const stopControl = props.run.availability.cancel && props.onCancel !== undefined ? (
        // Stop is bordered and neutral: a healthy run is never tinted (07 §3).
        <ToolbarButton
            key="stop"
            testID={`${testIDPrefix}-cancel`}
            disabled={operationPending}
            busy={operationPending}
            onPress={props.onCancel}
            destructive
            {...(primaryAction === 'stop' ? { tone: 'primary' as const } : {})}
            icon={<Icon name="stop" size={ICON_SIZE.sm}
                color={primaryAction === 'stop' ? theme.colors.button.primary.tint : theme.colors.text.secondary} />}
            label={props.pendingControl === 'cancel'
                ? t('workflows.run.stopping')
                : props.cancelRequested === true
                    ? t('workflows.run.stopAgain')
                    : t('workflows.run.stop')}
            size="md"
        />
    ) : null;
    // A phone page's controls start at the row's leading edge, so Stop leads them there: Pause at boundary
    // and Resume differ in width and would otherwise push Stop across the spot just tapped. The header's
    // controls end at its trailing edge, where Stop is last.
    const stateControls = (
        <>
            {phonePage ? stopControl : null}
            {outcomeActions}
            {props.run.availability.pause && props.onPause !== undefined ? (
                // Pause is the quiet one beside the bordered Stop (lab run-A): two outlines side by side would
                // say the two are equals. It reads what it does, "Pause at boundary" (07 §2.3 item 6).
                <SectionActionButton
                    testID={`${testIDPrefix}-pause`}
                    disabled={operationPending}
                    loading={operationPending}
                    onPress={props.onPause}
                    icon="pause-circle"
                    title={t('workflows.run.pauseAtBoundary')}
                />
            ) : null}
            {phonePage ? null : stopControl}
        </>
    );
    const overflowControl = menuActions.length === 0 ? null : (
        <ItemRowActions
            title={t('common.moreActions')}
            actions={menuActions}
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            overflowTriggerTestID={`${testIDPrefix}-overflow`}
        />
    );
    // A phone's navigation bar keeps only `⋯`; the state's own actions (Run again, See failures, Stop) stay
    // in the page under the outcome they answer, so the failed page's next step is never behind a menu (lab P1).
    const hasStateControls = canResume || remedyAction !== null
        || (onRunAgain !== undefined && !runAgainFolded) || (onAnotherRound !== undefined && !anotherRoundFolded)
        || (terminalOutcome !== null && (terminalOutcome.kind !== 'result_absent' || props.view !== 'steps'))
        || (props.run.availability.pause && props.onPause !== undefined)
        || (props.run.availability.cancel && props.onCancel !== undefined);
    const pageStateControls = phone && props.embedded !== true && hasStateControls;
    const runControls = (
        <View style={[styles.headerControls, outcomeUndecided ? styles.headerControlsHeld : null]}>
            {pageStateControls ? null : stateControls}
            {overflowControl}
        </View>
    );

    const header = (
        <View style={styles.root}>
            {props.embedded === true ? (
                // Inside a host pane (a Work peek, the Inbox's detail) the Run wears the pane's band
                // header, as a peeked Session does (lab session-D): mark, name and facts on the band,
                // the pane's own controls at its end, and the Run's controls on the row beneath.
                <DetailsTabHeader
                    testID={`${testIDPrefix}-header`}
                    title={props.title ?? t('workflows.contentUnavailable')}
                    columnMaxWidthPx={maxWidthStyle.maxWidth}
                    leading={<Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                    meta={embeddedHeaderMeta}
                    controls={<View testID={`${testIDPrefix}-controls`}>{runControls}</View>}
                />
            ) : (
                // On a phone the title hangs from the bar that named the page (lab P1), not the page's top rhythm.
                <NavigationLargeTitleProvider largeTitle={phone}>
                <PageHeader
                    testID={`${testIDPrefix}-header`}
                    title={props.title ?? t('workflows.contentUnavailable')}
                    alwaysShowTitle
                    // A phone gives the title the full width; the origin fact keeps the workflow glyph (lab P1).
                    leading={phone ? undefined : (
                        <PageHeaderMarkIcon name="tree-structure" />
                    )}
                    meta={headerMeta}
                    actions={runControls}
                    // The Run's controls hang from the title's line, top right, with its facts beneath at full width
                    // (lab run-A); a narrow main beside an open details pane never drops them under the title.
                    {...(phone ? {} : { actionsLayout: 'hang' as const })}
                />
                </NavigationLargeTitleProvider>
            )}
            <View
                testID={`${testIDPrefix}-outcome-region`}
                style={[styles.outcome, phone ? null : styles.onTitleEdge, props.completionEmphasis === true ? styles.outcomeCompleted : null]}
                accessibilityRole="summary"
            >
                {props.completionEmphasis === true ? <View testID={`${testIDPrefix}-outcome-emphasis`} /> : null}
                {/* The headline names the state; the attention card explains its concrete request. */}
                <View style={styles.outcomeLine}>
                    <WorkflowRunStateMark
                        state={props.run.state}
                        context={{ workflowCustodyState: props.run.workflowCustodyState,
                            cancelRequested: props.cancelRequested, machineReachable: props.machineReachable,
                            machineName: props.machineName ?? props.run.machineId }}
                        // Amber only when the outcome is the hold itself; a Paused or Running Run whose hold
                        // Needs you lists keeps its own calm mark (FIN-DESIGN-REVIEW L2).
                        inAttentionWindow={workflowRunOutcomeIsAttention({
                            state: props.run.state,
                            workflowCustodyState: props.run.workflowCustodyState,
                            cancelRequested: props.cancelRequested,
                            inAttentionWindow: props.run.attentionRequired === true || attentionRows.length > 0,
                        })}
                        testID={`${testIDPrefix}-outcome-mark`}
                    />
                    <Text testID={`${testIDPrefix}-outcome`} style={styles.outcomeSentence}>
                        {/* The status word leads in the heading weight; the sentence after it reads as
                            prose (lab run-A). Failure keeps its rose; healthy and done stay ink. */}
                        {outcomeLine.startsWith(outcomeWord) ? <>
                            <Text style={[styles.outcomeWord, outcomeFailed ? styles.outcomeWordFailed : null]}>{outcomeWord}</Text>
                            {outcomeLine.slice(outcomeWord.length)}
                        </> : outcomeLine}
                    </Text>
                </View>
                {/* The quiet second line: what keeps going and what waits on it (lab run-A). */}
                {consequence === null ? null : <Text testID={`${testIDPrefix}-consequence`} style={[styles.provenance, styles.outcomeDetail]}>
                    {consequence}
                </Text>}
                {failureReason ? <Text testID={`${testIDPrefix}-failure-reason`} style={[styles.provenance, styles.outcomeDetail]}>
                    {failureReason}
                </Text> : failureReasonPending ? (
                    // The cause's own line, held while the first failure resolves, so it fills in without moving the page.
                    <Text testID={`${testIDPrefix}-failure-reason-pending`} style={[styles.provenance, styles.outcomeDetail]}
                        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{'\u00A0'}</Text>
                ) : null}
                {failureRecoveryInstruction ? <Text testID={`${testIDPrefix}-failure-next`} style={[styles.provenance, styles.outcomeDetail]}>
                    {failureRecoveryInstruction}
                </Text> : null}
                {/* Contact loss is all that is known; resume choices come from
                    the recovery owner once the current state is. */}
                {props.machineReachable === false && (!props.machineStatus || props.machineStatus.bucket === 'offline') && !isTerminalWorkflowRunState(props.run.state)
                    // A selected step that stopped says when its choices appear, in its recovery card (DESIGN-17 R1).
                    && !(selectedInvocation?.lifecycle === 'failed' || selectedInvocation?.lifecycle === 'outcome_uncertain') ? (
                    <Text testID={`${testIDPrefix}-machine-unavailable`} style={styles.provenance}>
                        {/* Its cause first, so "choices will appear" never reads without a reason. */}
                        {props.machineName ? t('workflows.run.machineUnavailable', { machine: props.machineName }) : null}
                        {props.machineName ? ' ' : null}{t('workflows.run.machineUnavailableBody')}
                    </Text>
                ) : null}

                {props.usageLabel === null || props.usageLabel === undefined ? null : (
                    <Text testID={`${testIDPrefix}-usage`} style={styles.metric}>{props.usageLabel}</Text>
                )}
                {/* One final-output row: either the selected result, or its
                    explicit absence once the Run has settled. Never both. */}
                {/* A prose result reads as one quiet line under the outcome (lab run-A); a structured result
                    is read in its result pane, which Open result opens, never printed above the Map. */}
                {props.resultLabel === null || props.resultLabel === undefined
                    || normalizeResultPreview(props.resultLabel).kind === 'json' ? null : (
                    <Text testID={`${testIDPrefix}-result`} style={styles.metric} numberOfLines={2}>{props.resultLabel}</Text>
                )}

                {pageStateControls ? (
                    <View testID={`${testIDPrefix}-page-controls`} style={styles.headerControls}>{stateControls}</View>
                ) : phone && props.embedded !== true && outcomeUndecided ? <View style={styles.headerControlsHeld} /> : null}
                {props.runAgainStatus}
                {/* The durable receipt, so the request survives its own
                    transport and names what it is waiting on. */}
                {props.cancelRequested === true && !isTerminalWorkflowRunState(props.run.state) ? (
                    <Text testID={`${testIDPrefix}-cancel-requested`} style={styles.provenance}>
                        {t('workflows.run.stopRequested', {
                            machine: props.machineName ?? props.run.machineId,
                        })}
                    </Text>
                ) : null}
                {/* A terminal outcome and unresolved stop confirmation are separate owner facts. */}
                {props.deleteBlockedByCustody && (props.run.state === 'cancelled' || !stopPending) ? (
                    <Text testID={`${testIDPrefix}-custody-pending`} style={styles.provenance}>
                        {t('workflows.recovery.waitingForStop')}
                    </Text>
                ) : null}
                {/* A publication that waits on its approval names it and opens it, also once the Run is terminal. */}
                {approvalPresentation.unassigned.length === 0
                    || props.onOpenPublicationRequest === undefined ? null : (
                    <ListPresentationProvider value="page" pageInsets="contained">
                        <ItemGroup header="none" constrainToContentWidth={false}>
                            {approvalPresentation.unassigned.map((request) => (
                                <WorkflowRunPublicationRequestRow
                                    key={request.artifactId}
                                    testID={`${testIDPrefix}-publication-request-${request.artifactId}`}
                                    artifactId={request.artifactId}
                                    serverId={props.serverId}
                                    onOpen={() => props.onOpenPublicationRequest?.(request.href)}
                                />
                            ))}
                        </ItemGroup>
                    </ListPresentationProvider>
                )}
                {/* The problem and its repair read as one line: the sentence, then its inline action. */}
                <View style={styles.problemLine}>
                {props.errorLabel === null || props.errorLabel === undefined ? null : (
                    <Text
                        testID={`${testIDPrefix}-error`}
                        style={[styles.provenance, styles.problemText]}
                        // The canonical problem owner already decided whether
                        // this interrupts or reports; consumers discarded it and
                        // a failed Stop or Retry reached nobody using a reader.
                        accessibilityRole={(props.errorSemantics ?? 'alert') === 'alert' ? 'alert' : 'text'}
                        accessibilityLiveRegion={(props.errorSemantics ?? 'alert') === 'alert' ? 'assertive' : 'polite'}
                        role={props.errorSemantics ?? 'alert'}
                    >
                        {props.errorLabel}
                    </Text>
                )}
                {props.onReload === undefined ? null : (
                    <ToolbarButton
                        testID={`${testIDPrefix}-reload`}
                        label={props.reloadLabel ?? t('common.retry')}
                        onPress={props.onReload}
                        size="md"
                    />
                )}
                </View>
            </View>

            {attentionRows.length === 0 || phoneDock ? null : (
                <View
                    testID={`${testIDPrefix}-needs-you`}
                    style={[styles.section, styles.pageSection, phone ? null : styles.onTitleEdge]}
                    // A still-paged window cannot promise a total: the loaded
                    // rows are stated as loaded so a reader never mistakes them
                    // for every intervention that remains.
                    accessibilityLabel={props.attentionHasMore === true
                        ? `${String(attentionCount)} ${t('workflows.a11y.needsYouLoaded')}`
                        : t('workflows.a11y.needsYou', { count: attentionCount })}
                >
                    <View style={styles.sectionHeading}>
                        <Text style={styles.sectionTitle}>{t('workflows.run.needsYou')}</Text>
                        <Text style={styles.sectionCount}>{props.attentionHasMore === true
                            ? `${String(attentionCount)} ${t('workflows.run.needsYouLoadedCount')}`
                            : String(attentionCount)}</Text>
                    </View>
                    {/* What needs the person is an index of rows on the page's one neutral sheet (lab
                        run-A): the amber stays on the hand, the held step on the Map and the review card. */}
                    <ListPresentationProvider value="page" pageInsets="contained">
                        <ItemGroup header="none" constrainToContentWidth={false}>
                            {attentionIndexRows.map(({ invocation, members }) => {
                                const request = approvalPresentation.byInvocationId.get(invocation.id);
                                if (request && props.onOpenPublicationRequest) return (
                                    <WorkflowRunPublicationRequestRow
                                        key={invocation.id}
                                        testID={`${testIDPrefix}-needs-you-request-${request.artifactId}`}
                                        artifactId={request.artifactId}
                                        serverId={props.serverId}
                                        // Two invitations share one Action title; the item each belongs to tells them apart.
                                        context={formatMapOccurrence(derivedStructure.get(invocation.id)?.occurrence ?? [])}
                                        onOpen={() => props.onOpenPublicationRequest?.(request.href)}
                                    />
                                );
                                const step = invocationLabel(invocation) ?? t('workflows.contentUnavailable');
                                const reviewing = members.some((member) => member.id === props.selectedInvocationId);
                                const entry = derivedStructure.get(invocation.id);
                                // One row per step: a For-each's held items read as their count, and Review
                                // opens the first (DESIGN-15 R6), rather than one identical sentence per item.
                                const where = entry === undefined ? undefined : members.length > 1
                                    ? [formatOccurrence(entry.occurrence.filter((coordinate) => coordinate.kind !== 'item' && coordinate.kind !== 'iteration')),
                                        t('workflows.run.attentionItemCount', { count: members.length })].filter(Boolean).join(' \u00b7 ')
                                    : formatOccurrence(entry.occurrence);
                                return (
                                    <Item
                                        key={invocation.id}
                                        // A Wait that keeps its default name is already the instruction ("Wait for you").
                                        title={invocation.lifecycle !== 'waiting_for_review' ? step : attentionWaitsForYou(invocation)
                                            ? step === t('workflows.page.blocks.waitTitle') ? step : t('workflows.run.attentionWaitRow', { step })
                                            : t('workflows.run.attentionReviewRow', { step })}
                                        subtitle={invocation.lifecycle === 'waiting_for_review' ? where
                                            : [describeWorkflowInvocationLifecycle(invocation.lifecycle).label, where].filter(Boolean).join(' · ')}
                                        icon={<Icon name="hand" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />}
                                        showChevron={false}
                                        selected={reviewing}
                                        rightElement={
                                            <ToolbarButton
                                                testID={`${testIDPrefix}-needs-you-${invocation.id}`}
                                                onPress={(event) => selectInvocation(invocation.id, event)}
                                                active={reviewing}
                                                tone={invocation.id === primaryReviewId ? 'primary' : 'default'}
                                                label={reviewing ? t('workflows.run.reviewing') : t('workflows.run.review')}
                                                accessibilityLabel={`${t('workflows.run.review')}: ${step}`}
                                                size="md"
                                            />
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    </ListPresentationProvider>
                    {props.onLoadMoreAttention === undefined ? null : (
                        <WorkflowRunPagingAction
                            testIDPrefix={`${testIDPrefix}-needs-you`}
                            onLoadMore={props.onLoadMoreAttention}
                            loading={props.loadingMoreAttention === true}
                            failed={props.loadMoreAttentionFailed === true}
                        />
                    )}
                </View>
            )}

            {/* The view switch: Map · Steps · Activity (07 §2.1, §3 control table). `flow` stays the
                route's view id; the person reads the one map as Map. */}
            <View style={[styles.viewSwitch, phone ? styles.viewSwitchPhone : styles.viewSwitchOnMark]}>
                <View style={phone ? null : styles.viewTabs}>
                    <WorkflowPageNavigation navigation={navigation} phone={phone}
                        testIDPrefix={`${testIDPrefix}-view`}
                        onSelect={selectNavigation} />
                </View>
                {/* A phone folds the source action into ⋯, so a settled Run's phone page has no row here to reserve. */}
                {sourceFolded && isTerminalWorkflowRunState(props.run.state) ? null : <View style={[styles.viewActions, phone ? styles.viewActionsPhone : styles.viewActionsTrailing]}>
                    {/* A quiet way back to what is happening now; the source action stays the bordered one (lab run-A). */}
                    {isTerminalWorkflowRunState(props.run.state) ? null : <SectionActionButton testID={`${testIDPrefix}-show-current-work`}
                        title={t('workflows.run.showCurrentWork')} icon="target"
                        disabled={currentWork === null}
                        onPress={(event) => { if (currentWork !== null) selectInvocation(currentWork.id, event); }} />}
                    {sourceFolded ? null : props.sourceAction ? <ToolbarButton
                        testID={`${testIDPrefix}-${props.sourceAction.kind}-workflow`}
                        label={props.sourceAction.kind === 'edit' ? t('workflows.run.editWorkflow') : t('workflows.run.openWorkflow')}
                        size="md" onPress={props.sourceAction.onPress}
                    /> : props.sourceActionPending === true ? (
                        <View testID={`${testIDPrefix}-source-action-reserved`} style={styles.reservedSlot}
                            aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            <ToolbarButton label={t('workflows.run.editWorkflow')} size="md" disabled onPress={() => {}} />
                        </View>
                    ) : props.hasSource !== true && props.onSaveAsWorkflow ? <ToolbarButton
                        testID={`${testIDPrefix}-save-as-workflow`}
                        label={t('workflows.run.saveAsWorkflow')} size="md"
                        onPress={props.onSaveAsWorkflow} disabled={props.saveAsWorkflowPending === true}
                        busy={props.saveAsWorkflowPending === true}
                    /> : null}
                </View>}
            </View>
        </View>
    );

    /**
     * The one selected detail, built once and handed to whichever presentation
     * the layout selects. A different attempt is a different review — the
     * reviewed continuation and its disclosure never carry across — which the
     * modal presenter honours through `identity` and the inspector through
     * `key`.
     */
    const selectedDetail = React.useMemo(() => {
        const entry = props.selectedInvocationId === null ? undefined : derivedStructure.get(props.selectedInvocationId);
        let sourceKey = '$root';
        let definition = props.definition;
        // The occurrence's call path identifies the accepted sidecar. Child
        // workflows may reuse block ids; an unscoped id must not name a role.
        for (const coordinate of entry?.occurrence ?? []) {
            if (coordinate.kind !== 'workflow') continue;
            const call = definition === null ? undefined : walkWorkflowBlocks(definition.blocks)
                .find((block) => block.id === coordinate.blockId && block.kind === 'workflow');
            if (call?.kind !== 'workflow') { definition = null; break; }
            sourceKey = call.workflowRef;
            definition = props.frozenChildren?.[sourceKey] ?? null;
        }
        const leaf = definition === null || entry === undefined ? undefined
            : props.materializedLeaves?.find((candidate) => candidate.sourceKey === sourceKey && candidate.blockId === entry.blockId);
        const block = definition === null || entry === undefined ? undefined
            : walkWorkflowBlocks(definition.blocks).find((candidate) => candidate.id === entry.blockId);
        const agentTarget = leaf?.selection.agentTarget;
        const targetKey = agentTarget == null ? null : resolveBackendTargetKeyV2(agentTarget);
        const identity = leaf?.role?.name ?? (targetKey === null ? null : presentEngine({ agentTargetKey: targetKey }).label ?? targetKey);
        const attempt = selectedInvocation?.attempt ?? props.selectedInvocationProgress?.attempt;
        // The state and its execution time are said once, here (DESIGN-16 D5): "Attempt 1 · Completed · 5 min".
        // The time is the opened progress's own execution timing, never the index's admission timestamps.
        const lifecycle = selectedInvocation?.lifecycle;
        const parts = [block?.kind === 'wait' ? undefined : identity, entry === undefined ? undefined : formatOccurrence(entry.occurrence),
            block?.kind === 'wait' || attempt === undefined ? undefined : describeWorkflowInvocationAttempt(attempt).label,
            // A held result's card says its state on its own line; the header doesn't say it again.
            lifecycle === undefined || (lifecycle === 'waiting_for_review' && block?.kind !== 'wait' && props.renderReviewCard !== undefined) ? undefined
                : selectedInvocation !== null && attentionWaitsForYou(selectedInvocation) ? t('workflows.review.waitTitle')
                    : describeWorkflowInvocationLifecycle(lifecycle, { blockKind: props.selectedInvocationProgress?.blockKind ?? block?.kind }).label,
            formatWorkflowInvocationElapsedLabel(props.selectedInvocationProgress?.timing) ?? undefined];
        return {
            subtitle: parts.filter((part): part is string => Boolean(part)).join(' \u00b7 ') || null,
            waitPrompt: block?.kind === 'wait' ? block.document.text : null,
            // A finished Setup step names what it installed, from the input this Run froze.
            setupOutcome: block?.kind === 'action' && lifecycle === 'completed'
                ? describeWorkflowSetupOutcome({ blocks: [block], machine: setupMachine }) : null,
            machineSetupStep: block?.kind === 'action' && block.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1,
        };
    }, [attentionWaitsForYou, derivedStructure, formatOccurrence, presentEngine, props.definition, props.frozenChildren, setupMachine,
        props.materializedLeaves, props.selectedInvocationId, props.selectedInvocationProgress?.attempt,
        props.selectedInvocationProgress?.blockKind, props.selectedInvocationProgress?.timing, selectedInvocation]);
    const selectedDetailSubtitle = selectedDetail.subtitle;
    // A step with no recovery choice still has a way forward on this page: the action the Run itself offers
    // (Stop while it is open, Run again once it has ended, else the workflow it came from). The card names
    // that action instead of ending on what cannot be done.
    const noChoicesNext: WorkflowInvocationDetailProps['noChoicesNext'] =
        props.run.availability.cancel && props.onCancel !== undefined ? 'stop'
            : props.onRunAgain !== undefined ? 'run_again'
                : props.sourceAction ? 'open_workflow' : null;
    const detailProps = React.useMemo((): WorkflowInvocationDetailProps | null => (
        props.selectedInvocationId === null ? null : {
            continuationText: selectedRecoveryText?.continuation,
            onChangeContinuationText: (next) => setSelectedRecoveryText('continuation', next),
            replacementText: selectedRecoveryText?.replacement,
            onChangeReplacementText: (next) => setSelectedRecoveryText('replacement', next),
            onSelectInvocation: selectInvocation,
            progress: props.selectedInvocationProgress ?? null,
            finalResult: props.selectedInvocationId === props.finalOutputInvocationId && props.result !== undefined
                ? { value: props.result } : null,
            recovery,
            lifecycle: selectedInvocation?.lifecycle ?? null,
            waitPrompt: selectedDetail.waitPrompt,
            workspaceSourceLabel,
            cause: selectedInvocationCause,
            machine: props.machineReachable === undefined ? null : {
                name: props.machineName ?? props.run.machineId,
                reachable: props.machineReachable,
            },
            operationPending,
            recoveryPrimaryDisplay: primaryAction === 'stop' ? 'secondary' : 'default',
            noChoicesNext,
            setupOutcome: selectedDetail.setupOutcome,
            machineSetupStep: selectedDetail.machineSetupStep,
            // The Run's own replay, offered on the failed step that has no recovery choice of its own.
            ...(onRunAgain === undefined ? {} : { onRunAgain }),
            ...(props.onOpenMachineRemedy === undefined ? {} : { onOpenMachineRemedy: props.onOpenMachineRemedy }),
            testIDPrefix,
            ...(props.selectedContentUnavailable === undefined
                ? {}
                : { contentUnavailable: props.selectedContentUnavailable }),
            contentReadState: props.renderReviewCard === undefined ? props.selectedReadState : null,
            ...(props.onRespondToRequest === undefined
                ? {}
                : { onRespondToRequest: props.onRespondToRequest }),
            ...(props.pendingRequestIds === undefined
                ? {}
                : { pendingRequestIds: props.pendingRequestIds }),
            ...(props.onCopyWorkspace === undefined ? {} : { onCopyWorkspace: props.onCopyWorkspace }),
            ...(props.onOpenWorkspace === undefined ? {} : { onOpenWorkspace: props.onOpenWorkspace }),
            ...(props.onReattach === undefined ? {} : { onReattach: props.onReattach }),
            ...(props.onRetrySameConversation === undefined
                ? {}
                : { onRetrySameConversation: props.onRetrySameConversation }),
            ...(props.onRetryFreshAgent === undefined
                ? {}
                : { onRetryFreshAgent: props.onRetryFreshAgent }),
            ...(props.onRetry === undefined ? {} : { onRetry: props.onRetry }),
            ...(props.onRetryWithReplacement === undefined
                ? {}
                : { onRetryWithReplacement: props.onRetryWithReplacement }),
            ...(props.onContinuePrepared === undefined
                ? {}
                : { onContinuePrepared: props.onContinuePrepared }),
            ...(props.uncertaintyAcknowledged === undefined
                ? {}
                : { uncertaintyAcknowledged: props.uncertaintyAcknowledged }),
            ...(props.onAcknowledgeUncertainPriorEffects === undefined
                ? {}
                : { onAcknowledgeUncertainPriorEffects: props.onAcknowledgeUncertainPriorEffects }),
            ...(props.onStartReviewedNewRun === undefined
                ? {}
                : { onStartReviewedNewRun: props.onStartReviewedNewRun }),
            ...(props.onRunWithAnotherAgent === undefined ? {} : { onRunWithAnotherAgent: props.onRunWithAnotherAgent }),
            ...(props.onRestoreWorkspace === undefined ? {} : { onRestoreWorkspace: props.onRestoreWorkspace }),
        }
    ), [
        operationPending,
        primaryAction,
        noChoicesNext,
        onRunAgain,
        props.onOpenMachineRemedy,
        selectedDetail.setupOutcome,
        selectedDetail.machineSetupStep,
        props.onAcknowledgeUncertainPriorEffects,
        props.onContinuePrepared,
        props.onCopyWorkspace,
        props.onOpenWorkspace,
        props.onReattach,
        props.onRespondToRequest,
        props.onRestoreWorkspace,
        props.onRetry,
        props.onRetryFreshAgent,
        props.onRetrySameConversation,
        props.onRetryWithReplacement,
        props.onStartReviewedNewRun,
        props.onRunWithAnotherAgent,
        props.pendingRequestIds,
        props.selectedContentUnavailable,
        props.selectedReadState,
        props.renderReviewCard,
        props.selectedInvocationId,
        props.selectedInvocationProgress,
        props.finalOutputInvocationId,
        props.result,
        props.uncertaintyAcknowledged,
        recovery,
        selectedDetail.waitPrompt,
        selectedInvocation?.lifecycle,
        selectedInvocationCause,
        props.machineName,
        props.machineReachable,
        props.run.machineId,
        selectedRecoveryText,
        selectInvocation,
        setSelectedRecoveryText,
        testIDPrefix,
        workspaceSourceLabel,
    ]);
    const selectedDetailTitle = selectedInvocation === null
        ? t('workflows.run.untitled')
        : invocationLabel(selectedInvocation) ?? t('workflows.run.untitled');

    const selectedExecution = props.selectedInvocationProgress?.execution;
    const headerExecution = props.selectedRelatedExecution?.execution ?? selectedExecution;
    const headerExecutionInspectable = props.selectedRelatedExecution?.canInspectExecution ?? recovery.canInspectExecution;
    const selectedHeaderActions = headerExecutionInspectable && headerExecution !== undefined
        ? headerExecution.kind === 'detached_run' && props.onOpenExecutionRun !== undefined
            ? <IconButton testID={`${testIDPrefix}-selected-open-execution`} variant="plain" iconName="arrows-out"
                accessibilityLabel={t('workflows.run.openExecution')} tooltip={t('workflows.run.openExecution')}
                onPress={() => props.onOpenExecutionRun?.(headerExecution.runId)} />
            : (headerExecution.kind === 'session' || headerExecution.kind === 'session_ready') && props.onOpenSession !== undefined
                ? <IconButton testID={`${testIDPrefix}-selected-open-execution`} variant="plain" iconName="arrows-out"
                    accessibilityLabel={t('workflows.run.openConversation')} tooltip={t('workflows.run.openConversation')}
                    onPress={() => props.onOpenSession?.(headerExecution.sessionId)} />
                : null
        : null;
    const selectedAttentionIndex = attentionRows.findIndex((row) => row.id === props.selectedInvocationId);
    const previousHold = attentionRows[selectedAttentionIndex - 1];
    const nextHold = selectedAttentionIndex < 0 ? undefined : attentionRows[selectedAttentionIndex + 1];
    const selectedHeaderTrailing = selectedAttentionIndex < 0 || attentionRows.length < 2 ? null : <View style={[styles.actions, styles.holdNavigation]}>
        <Text style={styles.provenance}>{t('workflows.run.holdsPosition', { current: selectedAttentionIndex + 1, total: attentionRows.length, more: props.attentionHasMore === true })}</Text>
        {nextHold === undefined ? null : <Text numberOfLines={1} style={[styles.provenance, styles.holdNavigationNext]}>{t('workflows.run.nextHoldOccurrence', {
            step: [invocationLabel(nextHold), invocationOccurrenceLabel(nextHold)].filter(Boolean).join(' · ') || t('workflows.contentUnavailable'),
        })}</Text>}
        <RoundButton testID={`${testIDPrefix}-previous-hold`} size="mini" display="secondary" title="‹"
            accessibilityLabel={t('workflows.run.previousHold')} disabled={previousHold === undefined}
            onPress={() => { if (previousHold !== undefined) selectInvocation(previousHold.id); }} />
        <RoundButton testID={`${testIDPrefix}-next-hold`} size="mini" display="secondary" title="›"
            accessibilityLabel={t('workflows.run.nextHold')} disabled={nextHold === undefined}
            onPress={() => { if (nextHold !== undefined) selectInvocation(nextHold.id); }} />
    </View>;
    const selectedKind = props.selectedInvocationProgress?.blockKind;
    const selectedSessionId = (selectedKind !== undefined && selectedKind !== 'step') || selectedExecution?.kind === 'detached_run' ? null
        : props.selectedSessionId !== undefined ? props.selectedSessionId
            : selectedExecution?.kind === 'session' ? selectedExecution.sessionId : null;
    const inspector = detailProps === null || props.selectedInvocationId === null ? null : <WorkflowSelectedDetail
        key={props.selectedInvocationId} detail={detailProps} sessionId={selectedSessionId}
        serverId={props.serverId} active={props.active !== false} phone={phone}
        inlineHeader={!detailsPaneAvailable && props.invocationPage === true}
        title={selectedDetailTitle} subtitle={selectedDetailSubtitle} identity={props.selectedInvocationId}
        headerActions={selectedHeaderActions} headerTrailing={selectedHeaderTrailing}
        onClose={props.onDeselectInvocation}
        renderReviewCard={props.renderReviewCard} focusReturnRef={detailFocusReturnRef}
    />;

    const footer = (
        <View style={styles.root}>
            {technicalOpen ? (
            <View testID={`${testIDPrefix}-technical`} style={[styles.section, styles.pageSection]}>
                <Text style={styles.sectionLabel}>{t('workflows.run.technicalDetails')}</Text>
                    <>
                        <View style={styles.detailRow}>
                            <Text style={styles.detailKey}>{t('workflows.run.technical.runId')}</Text>
                            <Text testID={`${testIDPrefix}-run-id`} style={styles.detailValue} numberOfLines={1} selectable>
                                {props.run.id}
                            </Text>
                        </View>
                        {props.rolesChangedForRun && props.materializedLeaves !== undefined
                            ? <WorkflowAcceptedRunRoles leaves={props.materializedLeaves} /> : null}
                        {props.selectedInvocationId === null ? null : (
                            <View style={styles.detailRow}>
                                <Text style={styles.detailKey}>{t('workflows.run.technical.invocationId')}</Text>
                                <Text testID={`${testIDPrefix}-invocation-id`} style={styles.detailValue} numberOfLines={1} selectable>
                                    {props.selectedInvocationId}
                                </Text>
                            </View>
                        )}
                        <View style={styles.detailRow}>
                            <Text style={styles.detailKey}>{t('workflows.run.technical.machine')}</Text>
                            <Text testID={`${testIDPrefix}-machine`} style={styles.detailValue} numberOfLines={1} selectable>
                                {props.machineName ?? props.run.machineId}
                            </Text>
                        </View>
                        {/* The name identifies; the exact id still distinguishes. */}
                        {props.machineName === undefined
                            || props.machineName === null
                            || props.machineName === props.run.machineId ? null : (
                            <View style={styles.detailRow}>
                                <Text style={styles.detailKey}>{t('workflows.run.technical.machineId')}</Text>
                                <Text testID={`${testIDPrefix}-machine-id`} style={styles.detailValue} numberOfLines={1} selectable>
                                    {props.run.machineId}
                                </Text>
                            </View>
                        )}
                        <View style={styles.detailRow}>
                            <Text style={styles.detailKey}>{t('workflows.run.technical.revision')}</Text>
                            <Text testID={`${testIDPrefix}-revision`} style={styles.detailValue} numberOfLines={1} selectable>
                                {String(props.run.revision)}
                            </Text>
                        </View>
                    </>
            </View>
            ) : null}
            {/* The page's last content (the Map, or technical details when open) scrolls clear of the dock,
                which already rides above the floating bottom chrome, or else of that chrome itself. */}
            {phoneDock ? <View style={{ height: dockHeightPx }} />
                : chromeClearance > 0 ? <View style={{ height: chromeClearance }} /> : null}
        </View>
    );

    // Observation preferences open as their own card from ⋯ (the same canonical card every Run sheet uses).
    const notifyContent = React.useMemo(() => props.notificationOperation == null ? null
        : { content: <View testID={`${testIDPrefix}-notifications`}>{props.notificationOperation}</View> },
    [props.notificationOperation, testIDPrefix]);
    useWorkflowCardModal({
        open: notifyOpen && notifyContent !== null,
        component: RunDetailsSheet,
        props: notifyContent,
        title: t('sessionWork.notify.setup'),
        testID: `${testIDPrefix}-notifications-modal`,
        onRequestClose: () => setNotifyOpen(false),
        phonePresentation: 'sheet',
    });

    // Complete history distinguishes work the Run skipped from later work a failure prevented.
    const notStartedLabel = !isTerminalWorkflowRunState(props.run.state) ? t('workflows.invocationState.pending')
        : props.invocationsLoaded && props.invocationHistoryComplete
            ? props.run.state === 'succeeded' ? t('workflows.invocationState.skipped')
                : props.run.state === 'failed' ? t('workflows.run.notReached') : undefined
            : undefined;

    // Show the accepted Run immediately, while its map waits for the first step
    // states (DESIGN-15 R12). An unread held step must never say "Not started".
    const outline = props.view === 'steps' && props.definition !== null && props.invocationsLoaded ? (
        <ScrollView testID={`${testIDPrefix}-steps`} style={styles.scroll}
            contentContainerStyle={[styles.root, props.contentContainerStyle]}>
            {header}
            <View style={[styles.pageSection, phone ? null : styles.documentInset]}><WorkflowRunSteps runId={props.run.id} machineId={props.run.machineId} serverId={props.serverId}
                invocationStatusContext={invocationStatusContext}
                notStartedLabel={notStartedLabel}
                definition={props.definition} invocations={props.invocations} structure={derivedStructure}
                flowProjection={flowProjection ?? undefined} flowRunStates={flowRunStates}
                progressById={structureProgressById}
                materializedLeaves={props.materializedLeaves}
                inputs={props.inputs}
                sessionDisplayLabelsById={props.sessionDisplayLabelsById}
                frozenChildren={props.frozenChildren}
                selectedInvocationId={props.selectedInvocationId} onSelectInvocation={selectInvocation}
                occurrenceLabel={(entry) => formatOccurrence(entry.occurrence) ?? null}
                testIDPrefix={`${testIDPrefix}-steps`} /></View>
            {props.onLoadMoreInvocations === undefined ? null : <WorkflowRunPagingAction
                testIDPrefix={`${testIDPrefix}-steps`} onLoadMore={props.onLoadMoreInvocations}
                loading={props.loadingMoreInvocations === true} failed={props.loadMoreInvocationsFailed === true} />}
            {footer}
        </ScrollView>
    ) : props.view === 'activity' || flowProjection === null || !props.invocationsLoaded ? (
        <WorkflowInvocationList
            invocationStatusContext={invocationStatusContext}
            listRef={activityListRef}
            onScroll={captureActivityScroll}
            testIDPrefix={`${testIDPrefix}-invocations`}
            invocations={activityInvocations}
            loaded={props.invocationsLoaded}
            selectedInvocationId={props.selectedInvocationId}
            onSelectInvocation={selectInvocation}
            presentation={activityPresentation}
            rowInsetStyle={phone ? styles.documentInsetPhone : styles.documentInset}
            compact={phone}
            ListHeaderComponent={header}
            ListFooterComponent={footer}
            contentContainerStyle={props.contentContainerStyle}
            {...(props.onLoadMoreInvocations === undefined
                ? {}
                : { onLoadMore: props.onLoadMoreInvocations })}
            {...(props.loadingMoreInvocations === undefined
                ? {}
                : { loadingMore: props.loadingMoreInvocations })}
            {...(props.loadMoreInvocationsFailed === undefined
                ? {}
                : { loadMoreFailed: props.loadMoreInvocationsFailed })}
        />
    ) : (
        <ScrollView
            ref={flowScrollRef}
            testID={testIDPrefix}
            style={styles.scroll}
            contentContainerStyle={[styles.root, props.contentContainerStyle]}
            onScroll={captureFlowScroll}
            scrollEventThrottle={32}
        >
            {header}
            {/*
              * Flow shows the occurrences the invocation window has loaded. Paging
              * is therefore reachable from here too — otherwise an older occurrence
              * would be selectable only by first switching back to Activity.
              */}
            {props.onLoadMoreInvocations === undefined ? null : (
                <WorkflowRunPagingAction
                    testIDPrefix={`${testIDPrefix}-flow`}
                    onLoadMore={props.onLoadMoreInvocations}
                    loading={props.loadingMoreInvocations === true}
                    failed={props.loadMoreInvocationsFailed === true}
                />
            )}
            {/* The map shares the header's text edge, so mark, outcome, tabs and cards line up (lab run-A). */}
            <View style={styles.pageSection}><WorkflowFlowView
                invocationStatusContext={invocationStatusContext}
                testIDPrefix={`${testIDPrefix}-flow`}
                projection={flowProjection}
                selectedNodeId={props.selectedInvocationId === null
                    ? null
                    : derivedStructure.get(props.selectedInvocationId)?.nodeId ?? null}
                selectedInvocationId={props.selectedInvocationId}
                onSelectOccurrence={selectInvocation}
                agentMarkForNode={agentMarkForNode}
                {...(notStartedLabel === undefined ? {} : { notStartedLabel })}
                {...(flowRunStates === undefined ? {} : { runStates: flowRunStates })}
            /></View>
            {footer}
        </ScrollView>
    );

    const hideWorkflowLabel = t('panes.mainColumn.hideWorkflow');
    const showWorkflowLabel = t('panes.mainColumn.showWorkflow');
    const runName = props.title ?? t('workflows.contentUnavailable');
    const runMarkColor = theme.colors.text.secondary;
    const runPaneState = props.run.attentionRequired === true || attentionRows.length > 0 ? 'attention'
        : props.run.state === 'running' ? 'working' : undefined;
    // Publish only changes to the displayed pane facts, not local-control or inventory churn.
    const runMainColumn = React.useMemo<PaneMainColumnDescriptor>(() => ({
        hideLabel: hideWorkflowLabel,
        showLabel: showWorkflowLabel,
        identity: {
            mark: <Icon name="tree-structure" size={ICON_SIZE.sm} color={runMarkColor} />,
            name: runName,
            state: runPaneState,
        },
    }), [hideWorkflowLabel, showWorkflowLabel, runMarkColor, runName, runPaneState]);

    const dockStep = attentionIndexRows[0]?.invocation;
    const main = <View style={[styles.outline, maxWidthStyle]}>{outline}
        {phoneDock && dockStep !== undefined ? <WorkflowRunNeedsYouDock testIDPrefix={`${testIDPrefix}-needs-you-dock`}
            count={attentionIndexRows.length} steps={attentionIndexRows.map(({ invocation }) => invocationLabel(invocation)).filter((label): label is string => label !== null)}
            onReview={(event) => selectInvocation(dockStep.id, event)} onHeight={setDockHeightPx} primary={primaryAction === null} /> : null}
    </View>;
    if (!detailsPaneAvailable && props.invocationPage && inspector !== null) {
        return phone && selectedSessionId === null && props.renderReviewCard !== undefined
            ? <>{main}{inspector}</>
            : inspector;
    }
    if (!detailsPaneAvailable) return main;
    return <DetailsPaneHost main={main}
        mainColumn={runMainColumn}
        // A step is read and discussed at a Session's width; the Run keeps the rest of the page.
        detailsPreferredWidthPx={DEFAULT_SESSION_WIDTH_PX}
        onMainColumnControlsChange={navigation.onMainColumnControlsChange}
        details={inspector === null ? null : { content: inspector, header: { title: selectedDetailTitle, subtitle: selectedDetailSubtitle,
            actions: selectedHeaderActions, lineTrailing: selectedHeaderTrailing }, accessibilityLabel: selectedDetailTitle }}
        onCloseDetails={() => props.onDeselectInvocation?.()} />;
}
