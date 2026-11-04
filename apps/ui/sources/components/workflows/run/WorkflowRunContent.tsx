import * as React from 'react';
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
    type WorkflowDefinitionV1,
    type JsonValue,
    type WorkflowMaterializedLeafV1,
    type WorkflowInvocationRecoveryV1,
    type WorkflowInvocationRecoveryAvailabilityV1,
    type WorkflowRunInvocationIndexV1,
    type WorkflowRunSummaryV1,
    type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows';
import { formatWorkflowInvocationElapsedLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import {
    isWorkflowAttentionInvocation,
    describeWorkflowInvocationLifecycle,
    describeWorkflowInvocationAttempt,
    describeWorkflowRunState,
    isWorkflowWaitForYouHold,
    isTerminalWorkflowRunState,
    isWorkflowRunStopPending,
    summarizeWorkflowInvocationCoverage,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';
import { projectWorkflowFlow, resolveWorkflowFlowScopedNodeId } from '@/components/workflows/flow/workflowFlowProjection';
import { WorkflowFlowView } from '@/components/workflows/flow/WorkflowFlowView';
import { WorkflowRunStateMark } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { readPressFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import type { CustomModalInjectedProps } from '@/modal';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
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
import {
    compareWorkflowOccurrences,
    projectWorkflowFlowRunStates,
    formatWorkflowOccurrenceLabel,
    projectWorkflowInvocationStructure,
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
    formatWorkflowRunConsequenceSentence,
    formatWorkflowWorkspaceSourceLabel,
    describeWorkflowInvocationCause,
    projectWorkflowInvocationRecovery,
    projectWorkflowRunFailure,
    selectWorkflowRunFailureInvocation,
    type WorkflowRunFailurePresentation,
    type WorkflowRecoveryContinuation,
} from './workflowRunDetailPresentation';
import { formatWorkflowRunFailureCauseLine } from './workflowRunDetailPresentation';

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
    renderReviewCard?: (onDiscuss?: () => void, placement?: Readonly<{ compact: boolean; title: string; subtitle: string | null }>) => React.ReactNode;
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
    inputs?: Readonly<Record<string, JsonValue>>;
    /** Names from the Session display owner for the accepted Run's observed executions. */
    sessionDisplayLabelsById?: ReadonlyMap<string, string>;
    /** A frozen source remains a source even after it is deleted. */
    hasSource?: boolean;
    /** Current source existence/access, resolved by the source owner. */
    sourceAction?: Readonly<{ kind: 'edit' | 'open'; onPress: () => void }> | null;
    /** The source action's access is still being checked: its slot is reserved, never drawn. */
    sourceActionPending?: boolean;
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
    /** Exact final-output producer from the encrypted terminal result owner. */
    finalOutputInvocationId?: string | null;
    /** Earliest failed row from the lifecycle-indexed query owner. */
    firstFailedInvocationId: string | null;
    /** Whether the authoritative lifecycle-indexed failure query has settled. */
    firstFailedInvocationResolution: 'loading' | 'resolved' | 'error';
    /** Same exact cause, step identity and recovery facts consumed by See failures. */
    failurePresentation?: WorkflowRunFailurePresentation | null;
    selectedInvocationProgress?: WorkflowProgressEnvelopeV1 | null;
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
function WorkflowReviewCardModal(props: Readonly<{ card: React.ReactNode; contentSized: boolean }> & CustomModalInjectedProps): React.ReactElement {
    const { setChrome } = props;
    React.useEffect(() => {
        setChrome?.({ kind: 'card', scrollHost: props.contentSized ? 'overlay' : 'body', bodyScroll: props.contentSized ? 'auto' : 'none' });
        return () => setChrome?.(null);
    }, [props.contentSized, setChrome]);
    return <View style={{ ...(props.contentSized ? {} : { flex: 1 }), minHeight: 0, minWidth: 0 }}>{props.card}</View>;
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
        { compact: props.phone, title: props.title, subtitle: props.subtitle }) ?? null;
    const reviewOpen = props.phone && active && !reviewDismissed && card !== null;
    const paneHeaderScroll = usePaneHeaderScrollSink();
    const reportInspectorScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        paneHeaderScroll?.reportTopDistance(event.nativeEvent.contentOffset.y);
    }, [paneHeaderScroll]);
    useWorkflowCardModal({
        open: reviewOpen, component: WorkflowReviewCardModal,
        props: card === null ? null : { card, contentSized: props.detail.progress?.blockKind === 'wait' }, identity: props.identity,
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
    const reopenReview = props.phone && reviewDismissed && card !== null ? <HappierPressable
        testID={`${props.detail.testIDPrefix}-open-review`} accessibilityRole="button"
        disabled={!active}
        onPress={() => setReviewDismissed(false)} style={styles.actionTarget}>
        <Text style={styles.action}>{t('workflows.run.openReview')}</Text>
    </HappierPressable> : null;
    // A hold with no conversation belongs over the Run, not an empty step page.
    // Keep this owner mounted for sheet dismissal/reopening and draft continuity.
    if (props.phone && props.sessionId === null && card !== null) return reopenReview;
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {props.phone ? <PaneHeader testID={`${props.detail.testIDPrefix}-selected-header`}
            title={props.title} subtitle={props.subtitle} size="large" onClose={props.onClose} /> : null}
        {!props.phone && props.inlineHeader ? <DetailsTabHeader
            testID={`${props.detail.testIDPrefix}-selected-header`} title={props.title}
            leading={BackControl ? <BackControl style={null} /> : undefined}
            meta={props.subtitle ? [{ key: 'invocation', text: props.subtitle }] : undefined} /> : null}
        {!props.phone ? card : null}
        {reopenReview}
        {props.sessionId === null ? null : <SessionInPane sessionId={props.sessionId}
            serverId={props.serverId} active={active && !reviewOpen} composer />}
        <ScrollView testID={`${props.detail.testIDPrefix}-inspector`} accessibilityLabel={props.title}
            // The inspector is the body under the step's header: its scroll drives that header's shade.
            onScroll={paneHeaderScroll ? reportInspectorScroll : undefined} scrollEventThrottle={16}
            style={styles.scroll} contentContainerStyle={styles.inspectorContent}>
            <WorkflowInvocationDetail {...props.detail} />
        </ScrollView>
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
        () => (props.definition === null ? null : projectWorkflowFlow(props.definition, props.frozenChildren)),
        [props.definition, props.frozenChildren],
    );
    const structureProgressById = React.useMemo(() => {
        if (props.selectedInvocationId === null || props.selectedInvocationProgress == null) return props.invocationProgressById;
        if (props.invocationProgressById?.get(props.selectedInvocationId) === props.selectedInvocationProgress) return props.invocationProgressById;
        const progress = new Map(props.invocationProgressById);
        progress.set(props.selectedInvocationId, props.selectedInvocationProgress);
        return progress;
    }, [props.invocationProgressById, props.selectedInvocationId, props.selectedInvocationProgress]);
    const derivedStructure = React.useMemo(
        () => (props.invocationStructure !== undefined
            ? props.invocationStructure
            : projectWorkflowInvocationStructure({
                definition: props.definition,
                frozenChildren: props.frozenChildren,
                materializedLeaves: props.materializedLeaves,
                invocations: props.invocations,
                ...(structureProgressById === undefined
                    ? {}
                    : { progressByInvocationId: structureProgressById }),
            })),
        [props.definition, props.frozenChildren, props.materializedLeaves, structureProgressById, props.invocationStructure, props.invocations],
    );
    const attentionRows = React.useMemo(
        () => props.invocations.filter((entry) => isWorkflowAttentionInvocation(entry.lifecycle, derivedStructure.get(entry.id)?.coverageKind, props.run.state, props.cancelRequested)),
        [derivedStructure, props.invocations, props.run.state, props.cancelRequested],
    );
    const attentionCount = attentionRows.length;
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
            const repeatedNodeId = nodeId !== null && repeated ? nodeId : null;
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
    }, [attentionRows, derivedStructure]);
    /**
     * Activity lists the work inside the Run. The Run's own root row repeats what the header and
     * outcome already say, and Map and Steps never show it either.
     */
    const activityInvocations = React.useMemo(
        () => props.invocations.filter((invocation) => derivedStructure.get(invocation.id)?.blockId !== '$root'),
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
        props.saveAsWorkflowPending,
        technicalOpen,
        testIDPrefix,
    ]);
    const flowRunStates = React.useMemo(() => {
        if (props.view !== 'flow' || flowProjection === null) return undefined;
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

    /**
     * One dominant action per state (UX §1, §3.3).
     *
     * Tone was assigned per capability, so a completed Run that can also be
     * repeated drew **Open result** and **Run workflow again** as two filled
     * primaries and the outcome region lost its state-specific answer exactly
     * at the moment it matters. The state resolves the primary first; every
     * other eligible action stays secondary.
     */
    const primaryAction: 'outcome' | 'resume' | 'run_again' | null =
        terminalOutcome?.kind === 'open_result' || terminalOutcome?.kind === 'see_failures'
            || terminalOutcome?.kind === 'result_absent'
            ? 'outcome'
            : props.run.availability.resumeBoundary && props.onResume !== undefined
                ? 'resume'
                : props.run.state !== 'succeeded' && props.onRunAgain !== undefined
                    ? 'run_again'
                    : null;

    /** The row's authored block kind, from the frozen definition through the structure owner. */
    const invocationBlockKind = React.useCallback((invocation: WorkflowRunInvocationIndexV1): string | null => {
        const nodeId = derivedStructure.get(invocation.id)?.nodeId ?? null;
        return nodeId === null ? null : flowProjection?.nodesById.get(nodeId)?.kind ?? null;
    }, [derivedStructure, flowProjection]);
    const attentionWaitsForYou = React.useCallback((invocation: WorkflowRunInvocationIndexV1) => (
        isWorkflowWaitForYouHold(invocation.lifecycle, { blockKind: invocationBlockKind(invocation) })
    ), [invocationBlockKind]);
    const firstAttention = attentionRows[0];
    // A phone keeps what needs you in thumb reach while the Map scrolls.
    const phoneDock = phone && props.embedded !== true && attentionIndexRows.length > 0;
    const [dockHeightPx, setDockHeightPx] = React.useState(0);
    // One primary per view: while a hold is open beside the Run, its own card carries the primary,
    // so the index's Review stays bordered; with nothing open, the first hold is the page's next step.
    const primaryReviewId = props.selectedInvocationId === null ? attentionIndexRows[0]?.invocation.id : undefined;
    const firstAttentionLabel = firstAttention === undefined ? null : invocationLabel(firstAttention);
    const failureInvocation = props.firstFailedInvocationResolution === 'resolved'
        ? selectWorkflowRunFailureInvocation({ invocations: props.invocations, structure: derivedStructure,
            firstFailedInvocationId: props.firstFailedInvocationId }) ?? firstAttention ?? null
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
    const failedStepLabel = props.run.state === 'failed' ? failurePresentation?.step?.name ?? null : null;
    // Why the Run failed is said once: here, unless the inspector beside the header is open on that step and its
    // recovery card already heads with it. A phone pushes the step to its own page, so its header keeps the line.
    // The line names the failed step's number, what the attempt recorded
    // and a usage limit's reset, so the page says why without opening See failures (FIN-DESIGN-C4 R5).
    // An interrupted Run parked on a failed step says the same retained cause under its status.
    const failureReason = (props.run.state !== 'failed' && props.run.state !== 'interrupted') || failurePresentation == null
        || (!phone && props.selectedInvocationId === failurePresentation.invocationId) ? null
        : formatWorkflowRunFailureCauseLine(failurePresentation);
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
    const outcomeLine = formatWorkflowRunOutcomeLine({
        word: outcomeWord,
        sentence: formatWorkflowRunOutcomeSentence({
            run: props.run,
            cancelRequested: props.cancelRequested,
            coverage,
            historyComplete: props.invocationHistoryComplete,
            failure: failedStepLabel === null ? null : { step: failedStepLabel },
            attention: firstAttention === undefined || firstAttentionLabel === null ? null : {
                step: firstAttentionLabel,
                waitForYou: attentionWaitsForYou(firstAttention),
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
    ], [finishedAtMs, openOrigin, originLabel, props.machineName, startedAtMs, testIDPrefix]);
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
    const resumeAction = props.run.availability.resumeBoundary && props.onResume !== undefined ? (
        <ToolbarButton
            key="resume"
            testID={`${testIDPrefix}-resume`}
            disabled={operationPending}
            busy={operationPending}
            onPress={props.onResume}
            label={t('workflows.run.resume')}
            {...(primaryAction === 'resume' ? { tone: 'primary' as const } : {})}
            size="md"
        />
    ) : null;
    const runAgainAction = props.onRunAgain !== undefined ? (
        <View key="run-again" ref={props.runAgainAnchorRef} collapsable={false}>
            <ToolbarButton
                testID={`${testIDPrefix}-run-again`}
                onPress={props.onRunAgain}
                label={t('workflows.run.runAgain')}
                {...(primaryAction === 'run_again' ? { tone: 'primary' as const } : {})}
                size="md"
            />
        </View>
    ) : null;
    const anotherRoundAction = props.onAnotherRound !== undefined ? (
        <ToolbarButton
            key="another-round"
            testID={`${testIDPrefix}-another-round`}
            disabled={operationPending}
            onPress={props.onAnotherRound}
            label={t('workflows.start.anotherRound')}
            size="md"
        />
    ) : null;
    const outcomeAction = terminalOutcome?.kind === 'result_absent' && props.view !== 'steps' ? (
        <ToolbarButton
            key="inspect-steps"
            testID={`${testIDPrefix}-inspect-steps`}
            onPress={() => props.onChangeView('steps')}
            label={t('workflows.run.inspectSteps')}
            tone="primary"
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
    ) : terminalOutcome?.kind === 'see_failures' ? (
        <ToolbarButton
            key="see-failures"
            testID={`${testIDPrefix}-see-failures`}
            onPress={(event) => selectInvocation(terminalOutcome.invocationId, event)}
            label={t('workflows.run.seeFailures')}
            tone="primary"
            size="md"
        />
    ) : null;
    const primaryElement = primaryAction === 'outcome' ? outcomeAction
        : primaryAction === 'resume' ? resumeAction
            : primaryAction === 'run_again' ? runAgainAction : null;
    const phonePage = phone && props.embedded !== true;
    // One primary in the page (lab P1). On a phone page, and beside an open details pane where the header has a
    // narrow column, Run again and Another round fold into `⋯` unless one of them is the state's primary; a
    // phone page folds Open workflow there too, so no lone bordered button sits under the view switch.
    // `detailsPaneAvailable` already excludes an embedded Run.
    const compactActions = phonePage || (detailsPaneAvailable && props.selectedInvocationId !== null);
    const runAgainFolded = compactActions && runAgainAction !== null && primaryElement !== runAgainAction;
    const anotherRoundFolded = compactActions && anotherRoundAction !== null;
    const secondaryElements = [resumeAction, runAgainFolded ? null : runAgainAction, anotherRoundFolded ? null : anotherRoundAction, outcomeAction]
        .filter((element) => element !== null && element !== primaryElement);
    const sourceFolded = phonePage;
    const stateMenuActions: ItemAction[] = [
        ...(runAgainFolded && props.onRunAgain ? [{ id: `${testIDPrefix}-run-again`, title: t('workflows.run.runAgain'),
            icon: 'play' as const, onPress: props.onRunAgain }] : []),
        ...(anotherRoundFolded && props.onAnotherRound ? [{ id: `${testIDPrefix}-another-round`, title: t('workflows.start.anotherRound'),
            icon: 'arrows-clockwise' as const, disabled: operationPending, onPress: props.onAnotherRound }] : []),
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

    const stateControls = (
        <>
            {outcomeActions}
            {props.run.availability.pause && props.onPause !== undefined ? (
                // Pause is the quiet one beside the bordered Stop (lab run-A): two outlines side by side would
                // say the two are equals. "At boundary" is what it does, so it is the accessible name.
                <SectionActionButton
                    testID={`${testIDPrefix}-pause`}
                    disabled={operationPending}
                    loading={operationPending}
                    onPress={props.onPause}
                    icon="pause-circle"
                    title={t('workflows.run.pause')}
                    accessibilityLabel={t('workflows.run.pauseAtBoundary')}
                />
            ) : null}
            {/* Stop is bordered and neutral: a healthy run is never tinted (07 §3). */}
            {props.run.availability.cancel && props.onCancel !== undefined ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-cancel`}
                    disabled={operationPending}
                    busy={operationPending}
                    onPress={props.onCancel}
                    destructive
                    icon={<Icon name="stop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                    label={props.pendingControl === 'cancel'
                        ? t('workflows.run.stopping')
                        : props.cancelRequested === true
                            ? t('workflows.run.stopAgain')
                            : t('workflows.run.stop')}
                    size="md"
                />
            ) : null}
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
    const hasStateControls = (props.run.availability.resumeBoundary && props.onResume !== undefined)
        || (props.onRunAgain !== undefined && !runAgainFolded) || (props.onAnotherRound !== undefined && !anotherRoundFolded)
        || (terminalOutcome !== null && (terminalOutcome.kind !== 'result_absent' || props.view !== 'steps'))
        || (props.run.availability.pause && props.onPause !== undefined)
        || (props.run.availability.cancel && props.onCancel !== undefined);
    const pageStateControls = phone && props.embedded !== true && hasStateControls;
    const runControls = (
        <View style={styles.headerControls}>
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
                    leading={<Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                    meta={embeddedHeaderMeta}
                    controls={<View testID={`${testIDPrefix}-controls`}>{runControls}</View>}
                />
            ) : (
                <PageHeader
                    testID={`${testIDPrefix}-header`}
                    title={props.title ?? t('workflows.contentUnavailable')}
                    alwaysShowTitle
                    // A phone gives the title the full width; the origin fact keeps the workflow glyph (lab P1).
                    leading={phone ? undefined : (
                        <PageHeaderMarkSlot>
                            <Icon name="tree-structure" size={22} color={theme.colors.text.secondary} />
                        </PageHeaderMarkSlot>
                    )}
                    meta={headerMeta}
                    actions={runControls}
                />
            )}
            <View
                testID={`${testIDPrefix}-outcome-region`}
                style={[styles.outcome, props.completionEmphasis === true ? styles.outcomeCompleted : null]}
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
                        inAttentionWindow={(props.run.attentionRequired === true || attentionRows.length > 0) && !isTerminalWorkflowRunState(props.run.state)}
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
                </Text> : null}
                {/* Contact loss is all that is known; resume choices come from
                    the recovery owner once the current state is. */}
                {props.machineReachable === false && (!props.machineStatus || props.machineStatus.bucket === 'offline') && !isTerminalWorkflowRunState(props.run.state)
                    // A selected step that stopped says when its choices appear, in its recovery card (DESIGN-17 R1).
                    && !(selectedInvocation?.lifecycle === 'failed' || selectedInvocation?.lifecycle === 'outcome_uncertain') ? (
                    <Text testID={`${testIDPrefix}-machine-unavailable`} style={styles.provenance}>
                        {t('workflows.run.machineUnavailableBody')}
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
                ) : null}
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
                {/* While the Stop is pending the outcome line already says so; the custody mechanism is not repeated. */}
                {props.deleteBlockedByCustody && !stopPending ? (
                    <Text testID={`${testIDPrefix}-custody-pending`} style={styles.provenance}>
                        {t('workflows.recovery.waitingForStop')}
                    </Text>
                ) : null}
                {/* A publication that waits on its approval names it and opens it, also once the Run is terminal. */}
                {props.publicationRequests === undefined || props.publicationRequests.length === 0
                    || props.onOpenPublicationRequest === undefined ? null : (
                    <ListPresentationProvider value="page" pageInsets="contained">
                        <ItemGroup header="none" constrainToContentWidth={false}>
                            {props.publicationRequests.map((request) => (
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
                    style={[styles.section, styles.pageSection]}
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
                                        title={invocation.lifecycle !== 'waiting_for_review' ? step : attentionWaitsForYou(invocation)
                                            ? t('workflows.run.attentionWaitRow', { step })
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
            <View style={[styles.viewSwitch, phone ? styles.viewSwitchPhone : null]}>
                <SegmentedTabBar
                    testIDPrefix={`${testIDPrefix}-view`}
                    accessibilityLabel={t('workflows.tabsAccessibility.runViews')}
                    segmentSizing={phone ? 'equal' : 'content'}
                    tabs={[
                        { id: 'flow' as const, label: t('workflows.tabs.map') },
                        { id: 'steps' as const, label: t('workflows.tabs.steps') },
                        { id: 'activity' as const, label: t('workflows.tabs.activity') },
                    ]}
                    activeTabId={props.view}
                    onSelectTab={props.onChangeView}
                />
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
        const parts = [identity, entry === undefined ? undefined : formatOccurrence(entry.occurrence),
            attempt === undefined ? undefined : describeWorkflowInvocationAttempt(attempt).label,
            lifecycle === undefined ? undefined
                : selectedInvocation !== null && attentionWaitsForYou(selectedInvocation) ? t('workflows.review.waitTitle')
                    : describeWorkflowInvocationLifecycle(lifecycle, { blockKind: props.selectedInvocationProgress?.blockKind ?? block?.kind }).label,
            formatWorkflowInvocationElapsedLabel(props.selectedInvocationProgress?.timing) ?? undefined];
        return {
            subtitle: parts.filter((part): part is string => Boolean(part)).join(' \u00b7 ') || null,
            waitPrompt: block?.kind === 'wait' ? block.document.text : null,
        };
    }, [attentionWaitsForYou, derivedStructure, formatOccurrence, presentEngine, props.definition, props.frozenChildren,
        props.materializedLeaves, props.selectedInvocationId, props.selectedInvocationProgress?.attempt,
        props.selectedInvocationProgress?.blockKind, props.selectedInvocationProgress?.timing, selectedInvocation]);
    const selectedDetailSubtitle = selectedDetail.subtitle;
    const detailProps = React.useMemo((): WorkflowInvocationDetailProps | null => (
        props.selectedInvocationId === null ? null : {
            continuationText: selectedRecoveryText?.continuation,
            onChangeContinuationText: (next) => setSelectedRecoveryText('continuation', next),
            replacementText: selectedRecoveryText?.replacement,
            onChangeReplacementText: (next) => setSelectedRecoveryText('replacement', next),
            onSelectInvocation: selectInvocation,
            progress: props.selectedInvocationProgress ?? null,
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
            testIDPrefix,
            ...(props.selectedContentUnavailable === undefined
                ? {}
                : { contentUnavailable: props.selectedContentUnavailable }),
            contentReadState: props.renderReviewCard === undefined ? props.selectedReadState : null,
            ...(props.onOpenSession === undefined ? {} : { onOpenSession: props.onOpenSession }),
            ...(props.onOpenExecutionRun === undefined
                ? {}
                : { onOpenExecutionRun: props.onOpenExecutionRun }),
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
        props.onAcknowledgeUncertainPriorEffects,
        props.onContinuePrepared,
        props.onCopyWorkspace,
        props.onOpenExecutionRun,
        props.onOpenSession,
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
    const selectedKind = props.selectedInvocationProgress?.blockKind;
    const selectedSessionId = (selectedKind !== undefined && selectedKind !== 'step') || selectedExecution?.kind === 'detached_run' ? null
        : props.selectedSessionId !== undefined ? props.selectedSessionId
            : selectedExecution?.kind === 'session' ? selectedExecution.sessionId : null;
    const inspector = detailProps === null || props.selectedInvocationId === null ? null : <WorkflowSelectedDetail
        key={props.selectedInvocationId} detail={detailProps} sessionId={selectedSessionId}
        serverId={props.serverId} active={props.active !== false} phone={phone}
        inlineHeader={!detailsPaneAvailable && props.invocationPage === true}
        title={selectedDetailTitle} subtitle={selectedDetailSubtitle} identity={props.selectedInvocationId}
        onClose={props.onDeselectInvocation}
        renderReviewCard={props.renderReviewCard} focusReturnRef={detailFocusReturnRef}
    />;

    const footer = (
        <View style={styles.root}>
            {/* The last row clears the dock and the shell's bottom chrome. */}
            {phoneDock ? <View style={{ height: dockHeightPx }} /> : null}
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

    const outline = props.view === 'steps' && props.definition !== null ? (
        <ScrollView testID={`${testIDPrefix}-steps`} style={styles.scroll}
            contentContainerStyle={[styles.root, props.contentContainerStyle]}>
            {header}
            <View style={styles.pageSection}><WorkflowRunSteps runId={props.run.id} machineId={props.run.machineId} serverId={props.serverId}
                invocationStatusContext={invocationStatusContext}
                definition={props.definition} invocations={props.invocations} structure={derivedStructure}
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
    ) : props.view === 'activity' || flowProjection === null ? (
        <WorkflowInvocationList
            invocationStatusContext={invocationStatusContext}
            listRef={activityListRef}
            onScroll={captureActivityScroll}
            testIDPrefix={`${testIDPrefix}-invocations`}
            invocations={activityInvocations}
            loaded={props.invocationsLoaded}
            selectedInvocationId={props.selectedInvocationId}
            onSelectInvocation={selectInvocation}
            resolveInvocationLabel={invocationLabel}
            resolveInvocationOccurrenceLabel={invocationOccurrenceLabel}
            resolveInvocationBlockKind={invocationBlockKind}
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
                {...(/* A completed Run with every occurrence loaded skipped what it never ran ("1 skipped" in the outcome;
                    lab run-A "Not needed"); a stopped or failed Run leaves unreached steps unlabelled. */
                    !isTerminalWorkflowRunState(props.run.state) ? { notStartedLabel: t('workflows.run.notStarted') }
                    : props.run.state === 'succeeded' && props.invocationsLoaded && props.invocationHistoryComplete
                        ? { notStartedLabel: t('workflows.invocationState.skipped') } : {})}
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
        details={inspector === null ? null : { content: inspector, header: { title: selectedDetailTitle, subtitle: selectedDetailSubtitle }, accessibilityLabel: selectedDetailTitle }}
        onCloseDetails={() => props.onDeselectInvocation?.()} />;
}
