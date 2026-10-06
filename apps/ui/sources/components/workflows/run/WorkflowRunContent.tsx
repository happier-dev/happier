import * as React from 'react';
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
    type WorkflowMaterializedLeafV1,
    type WorkflowInvocationRecoveryV1,
    type WorkflowInvocationRecoveryAvailabilityV1,
    type WorkflowRunInvocationIndexV1,
    type WorkflowRunSummaryV1,
    type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { workStatusSurfaceStyle } from '@/components/work/status/workStatusTreatment';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import {
    WORKFLOW_ATTENTION_LIFECYCLES,
    describeWorkflowInvocationLifecycle,
    describeWorkflowInvocationAttempt,
    isWorkflowWaitForYouHold,
    isTerminalWorkflowRunState,
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
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { SessionInPane } from '@/components/sessions/panes/SessionInPane';
import { useSessionInteractionSource } from '@/sync/domains/state/storage';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useDeviceType } from '@/utils/platform/responsive';
import { useUnistyles } from 'react-native-unistyles';

import { WorkflowInvocationDetail, type WorkflowInvocationDetailProps } from './WorkflowInvocationDetail';
import { useWorkflowCardModal } from './useWorkflowCardModal';
import { WorkflowInvocationList } from './WorkflowInvocationList';
import { WorkflowRunSteps } from './WorkflowRunSteps';
import {
    projectWorkflowFlowRunStates,
    projectWorkflowInvocationStructure,
    type WorkflowInvocationStructureEntry,
    type WorkflowOccurrenceCoordinate,
} from './workflowInvocationStructure';
import { workflowRunStyles as styles } from './workflowRunStyles';
import {
    formatWorkflowRunOriginLabel,
    formatWorkflowRunOutcomeLabel,
    formatWorkflowRunOutcomeLine,
    formatWorkflowRunOutcomeSentence,
    formatWorkflowWorkspaceSourceLabel,
    describeWorkflowInvocationCause,
    projectWorkflowInvocationRecovery,
    type WorkflowRecoveryContinuation,
} from './workflowRunDetailPresentation';

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
    renderReviewCard?: (onDiscuss?: () => void, placement?: Readonly<{ compact: boolean }>) => React.ReactNode;
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
    /** A quiet observation request, independent of durable Run controls. */
    notificationOperation?: React.ReactNode;
    /** The frozen definition this Run was admitted with, when it has been read. */
    definition: WorkflowDefinitionV1 | null;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    /** Accepted execution identities, never today's role or engine defaults. */
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    /** A frozen source remains a source even after it is deleted. */
    hasSource?: boolean;
    /** Current source existence/access, resolved by the source owner. */
    sourceAction?: Readonly<{ kind: 'edit' | 'open'; onPress: () => void }> | null;
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
    firstFailedInvocationId?: string | null;
    /**
     * Whether the authoritative lifecycle-indexed failure query has settled.
     * Omitted retains the compatibility path for callers that only have a
     * complete local history window.
     */
    firstFailedInvocationResolution?: 'loading' | 'resolved' | 'error';
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
    onSaveAsWorkflow?: () => void;
    saveAsWorkflowPending?: boolean;
    deleteBlockedByCustody?: boolean;
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
    selectedContentUnavailable?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    testIDPrefix?: string;
}>;

/**
 * The phone review card, handed to the canonical modal owner over its exact step page.
 */
function WorkflowReviewCardModal(props: Readonly<{ card: React.ReactNode }> & CustomModalInjectedProps): React.ReactElement {
    const { setChrome } = props;
    React.useEffect(() => {
        setChrome?.({ kind: 'card', scrollHost: 'body', bodyScroll: 'none' });
        return () => setChrome?.(null);
    }, [setChrome]);
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{props.card}</View>;
}

/** The selected leaf's own Session grants decide Discuss; Run write access never grants chat. */
function WorkflowSelectedDetail(props: Readonly<{
    detail: WorkflowInvocationDetailProps;
    sessionId: string | null;
    serverId?: string | null;
    active: boolean;
    phone: boolean;
    title: string;
    subtitle: string | null;
    onClose?: () => void;
    identity: string;
    renderReviewCard?: WorkflowRunContentProps['renderReviewCard'];
    focusReturnRef: React.RefObject<FocusReturnTarget>;
}>): React.ReactElement {
    const source = useSessionInteractionSource(props.sessionId ?? '', props.serverId);
    const interaction = deriveTranscriptInteractionFromSession(source ?? {});
    const executeCommand = useKeyboardCommand();
    const layoutActive = useLayoutPresentationActive();
    const active = props.active && layoutActive;
    const [reviewDismissed, setReviewDismissed] = React.useState(false);
    const [focusRequested, setFocusRequested] = React.useState(false);
    const discuss = React.useCallback(() => {
        setReviewDismissed(true);
        setFocusRequested(true);
    }, []);
    const card = props.renderReviewCard?.(props.sessionId !== null && interaction.canSendMessages ? discuss : undefined, { compact: props.phone }) ?? null;
    const reviewOpen = props.phone && active && !reviewDismissed && card !== null;
    useWorkflowCardModal({
        open: reviewOpen, component: WorkflowReviewCardModal,
        props: card === null ? null : { card }, identity: props.identity,
        title: props.title, testID: `${props.detail.testIDPrefix}-review-modal`,
        focusReturnRef: props.focusReturnRef,
        onRequestClose: () => setReviewDismissed(true),
    });
    React.useEffect(() => {
        if (!focusRequested || reviewOpen || !active) return;
        executeCommand('composer.focus');
        setFocusRequested(false);
    }, [executeCommand, focusRequested, active, reviewOpen]);
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {props.phone ? <PaneHeader testID={`${props.detail.testIDPrefix}-selected-header`}
            title={props.title} subtitle={props.subtitle} size="large" onClose={props.onClose} /> : null}
        {!props.phone ? card : null}
        {props.phone && reviewDismissed && card !== null ? <HappierPressable
            testID={`${props.detail.testIDPrefix}-open-review`} accessibilityRole="button"
            disabled={!active}
            onPress={() => setReviewDismissed(false)} style={styles.actionTarget}>
            <Text style={styles.action}>{t('workflows.run.openReview')}</Text>
        </HappierPressable> : null}
        {props.sessionId === null ? null : <SessionInPane sessionId={props.sessionId}
            serverId={props.serverId} active={active && !reviewOpen} composer />}
        <ScrollView testID={`${props.detail.testIDPrefix}-inspector`} accessibilityLabel={props.title}
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
    const operationPending = props.pendingControl !== null && props.pendingControl !== undefined;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    /**
     * Wide layouts keep the selected detail in a neighbouring inspector beside
     * the outline; compact ones present it through the canonical modal (UX
     * §3.2, §4.5). Both read the same selection and the same reviewed buffers.
     */
    const detailsPaneAvailable = useDetailsPaneAvailable();
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
    const attentionRows = React.useMemo(
        () => props.invocations.filter((entry) => WORKFLOW_ATTENTION_LIFECYCLES.includes(entry.lifecycle)),
        [props.invocations],
    );
    const attentionCount = attentionRows.length;

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
                invocations: props.invocations,
                ...(structureProgressById === undefined
                    ? {}
                    : { progressByInvocationId: structureProgressById }),
            })),
        [props.definition, props.frozenChildren, structureProgressById, props.invocationStructure, props.invocations],
    );
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
        knownFailure: props.firstFailedInvocationId != null,
    }), [derivedStructure, props.firstFailedInvocationId, props.invocationHistoryComplete, props.invocations, props.invocationsLoaded, props.run.state]);

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

    const formatOccurrence = React.useCallback((
        occurrence: readonly WorkflowOccurrenceCoordinate[],
    ): string | undefined => {
        if (occurrence.length === 0) return undefined;
        const workflowPath: string[] = [];
        return occurrence.map((coordinate) => {
            if (coordinate.kind === 'branch') {
                return flowProjection?.nodesById.get(resolveWorkflowFlowScopedNodeId(`${coordinate.blockId}#${coordinate.branchId}`, workflowPath))?.label
                    ?? coordinate.branchId;
            }
            if (coordinate.kind === 'workflow') {
                const label = flowProjection?.nodesById.get(resolveWorkflowFlowScopedNodeId(coordinate.blockId, workflowPath))?.label;
                workflowPath.push(coordinate.blockId);
                return label ?? t('workflows.page.blocks.menuRun');
            }
            const noun = coordinate.kind === 'item'
                ? t('workflows.input.currentItem')
                : t('workflows.input.iteration');
            return `${noun} ${coordinate.index + 1}`;
        }).join(' / ');
    }, [flowProjection]);
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
        props.onDelete,
        props.onSaveAsWorkflow,
        props.saveAsWorkflowPending,
        testIDPrefix,
    ]);
    const flowRunStates = React.useMemo(() => {
        if (flowProjection === null) return undefined;
        // Which authored node a row belongs to is the structure owner's answer,
        // so an occurrence stays selectable before its private detail has ever
        // been opened.
        return projectWorkflowFlowRunStates({
            invocations: props.invocations,
            structure: derivedStructure,
            formatOccurrence,
        });
    }, [derivedStructure, flowProjection, formatOccurrence, props.invocations]);

    /**
     * The terminal primary action (UX §3.3).
     *
     * Both arms navigate to an exact invocation the canonical structure owner
     * already resolved — the authored `finalOutput` producer, or the first
     * failed row — rather than to "the latest row". When the Run is terminal and
     * no selected final result exists, the absence is stated instead of implied.
     */
    const terminalOutcome = React.useMemo((): Readonly<{
        kind: 'open_result'; invocationId: string;
    } | {
        kind: 'see_failures'; invocationId: string;
    } | {
        kind: 'result_absent';
    }> | null => {
        if (!isTerminalWorkflowRunState(props.run.state)) return null;
        if (props.firstFailedInvocationResolution !== undefined
            && props.firstFailedInvocationResolution !== 'resolved') return null;
        const firstFailedInvocationId = props.firstFailedInvocationResolution === 'resolved'
            ? props.firstFailedInvocationId ?? null
            : props.firstFailedInvocationId === undefined
                ? props.invocations.find((invocation) => invocation.lifecycle === 'failed')?.id
                : props.firstFailedInvocationId;
        if (firstFailedInvocationId !== undefined && firstFailedInvocationId !== null) {
            return { kind: 'see_failures', invocationId: firstFailedInvocationId };
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
    }, [props.definition, props.finalOutputInvocationId, props.firstFailedInvocationId, props.firstFailedInvocationResolution, props.invocations, props.resultLabel, props.run.state]);

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
    const firstAttentionLabel = firstAttention === undefined ? null : invocationLabel(firstAttention);
    const outcomeWord = formatWorkflowRunOutcomeLabel({
        state: props.run.state,
        coverage,
        historyComplete: props.invocationHistoryComplete,
        waitingOnlyForYou: attentionRows.length > 0 && attentionRows.every(attentionWaitsForYou),
    });
    const outcomeLine = formatWorkflowRunOutcomeLine({
        word: outcomeWord,
        sentence: formatWorkflowRunOutcomeSentence({
            run: props.run,
            coverage,
            historyComplete: props.invocationHistoryComplete,
            attention: firstAttention === undefined || firstAttentionLabel === null ? null : {
                step: firstAttentionLabel,
                waitForYou: attentionWaitsForYou(firstAttention),
            },
            ...(props.machineReachable === undefined ? {} : {
                machine: {
                    name: props.machineName ?? props.run.machineId,
                    reachable: props.machineReachable,
                },
            }),
        }),
    });
    const startedAtMs = Date.parse(props.run.createdAt);
    // Only the server's own terminal-transition instant ends the range; `updatedAt` also moves for
    // later custody and delivery bookkeeping, so it never stands in for a finish.
    const finishedAtMs = props.run.finishedAt == null ? Number.NaN : Date.parse(props.run.finishedAt);
    const originLabel = formatWorkflowRunOriginLabel(props.run.origin);
    const headerMeta = React.useMemo((): PageHeaderMetaFact[] => [
        { key: 'origin', text: originLabel, icon: 'tree-structure', testID: `${testIDPrefix}-origin` },
        ...(props.machineName ? [{ key: 'machine', text: props.machineName, icon: 'desktop' as const }] : []),
        ...(!Number.isFinite(startedAtMs) ? [] : Number.isFinite(finishedAtMs)
            ? [{ key: 'time', text: t('workflows.run.timeRange', { start: formatAsOfTime(startedAtMs), end: formatAsOfTime(finishedAtMs) }) }]
            : [{ key: 'time', text: t('workflows.run.startedAt', { time: formatAsOfTime(startedAtMs) }) }]),
    ], [finishedAtMs, originLabel, props.machineName, startedAtMs, testIDPrefix]);
    const sourceSessionId = props.run.origin.kind === 'direct'
        ? props.run.origin.originSessionId ?? null
        : null;
    const selectedInvocation = props.selectedInvocationId === null
        ? null
        : props.invocations.find((invocation) => invocation.id === props.selectedInvocationId) ?? null;
    const currentWork = React.useMemo(() => {
        if (isTerminalWorkflowRunState(props.run.state)) return null;
        const executableRows = props.invocations.filter((row) => derivedStructure.get(row.id)?.coverageKind === 'executable');
        return executableRows.find((row) => WORKFLOW_ATTENTION_LIFECYCLES.includes(row.lifecycle))
            ?? executableRows.find((row) => describeWorkflowInvocationLifecycle(row.lifecycle).marker.kind === 'activity')
            ?? null;
    }, [derivedStructure, props.invocations, props.run.state]);
    const recovery = React.useMemo(() => {
        const projected = projectWorkflowInvocationRecovery({
            run: props.run,
            invocation: selectedInvocation,
            progress: props.selectedInvocationProgress ?? null,
            recoveryAvailability: props.selectedInvocationRecoveryAvailability ?? null,
            machineHomeDirectory: props.workspaceHomeDirectory ?? null,
            invocations: props.invocations,
            invocationHistoryComplete: props.invocationHistoryComplete,
        });
        return props.preparedRecovery === undefined
            ? projected
            : { ...projected, preparedRecovery: props.preparedRecovery };
    }, [props.invocationHistoryComplete, props.invocations, props.preparedRecovery, props.run, selectedInvocation, props.selectedInvocationProgress, props.selectedInvocationRecoveryAvailability, props.workspaceHomeDirectory]);
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
        blockLabel: selectedNodeId === null ? null : flowProjection?.nodesById.get(selectedNodeId)?.label ?? null,
    });
    const workspaceSourceLabel = workspaceSourceBlockLabel === null
        ? null
        : formatWorkflowWorkspaceSourceLabel(
            workspaceSourceBlockLabel,
            selectedWorkspace?.sourceInvocationRecordId ?? null,
        );

    /**
     * The state's actions sit in the header beside the Run's own controls (lab run-A): secondary
     * ones first, the one primary last before `⋯`. Inspect steps is withdrawn while Steps is open,
     * since it would only point at the view already showing.
     */
    const outcomeActions = (
        <>
            {props.run.availability.resumeBoundary && props.onResume !== undefined ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-resume`}
                    disabled={operationPending}
                    busy={operationPending}
                    onPress={props.onResume}
                    style={styles.actionTarget}
                    label={t('workflows.run.resume')}
                    {...(primaryAction === 'resume' ? { tone: 'primary' as const } : {})}
                    size="md"
                />
            ) : null}
            {props.onRunAgain !== undefined ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-run-again`}
                    onPress={props.onRunAgain}
                    style={styles.actionTarget}
                    label={t('workflows.run.runAgain')}
                    {...(primaryAction === 'run_again' ? { tone: 'primary' as const } : {})}
                    size="md"
                />
            ) : null}
            {terminalOutcome?.kind === 'result_absent' && props.view !== 'steps' ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-inspect-steps`}
                    onPress={() => props.onChangeView('steps')}
                    style={styles.actionTarget}
                    label={t('workflows.run.inspectSteps')}
                    tone="primary"
                    size="md"
                />
            ) : null}
            {terminalOutcome?.kind === 'open_result' ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-open-result`}
                    onPress={(event) => selectInvocation(terminalOutcome.invocationId, event)}
                    style={styles.actionTarget}
                    label={t('workflows.run.openResult')}
                    tone="primary"
                    size="md"
                />
            ) : null}
            {terminalOutcome?.kind === 'see_failures' ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-see-failures`}
                    onPress={(event) => selectInvocation(terminalOutcome.invocationId, event)}
                    style={styles.actionTarget}
                    label={t('workflows.run.seeFailures')}
                    tone="primary"
                    size="md"
                />
            ) : null}
        </>
    );

    const runControls = (
        <View style={styles.headerControls}>
            {outcomeActions}
            {props.run.availability.pause && props.onPause !== undefined ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-pause`}
                    disabled={operationPending}
                    busy={operationPending}
                    onPress={props.onPause}
                    style={styles.actionTarget}
                    icon={<Icon name="pause-circle" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                    label={t('workflows.run.pauseAtBoundary')}
                    size="md"
                />
            ) : null}
            {/* Stop is bordered and neutral: a healthy run is never tinted (07 §3). */}
            {props.run.availability.cancel && props.onCancel !== undefined ? (
                <ToolbarButton
                    testID={`${testIDPrefix}-cancel`}
                    disabled={operationPending}
                    busy={operationPending}
                    onPress={props.onCancel}
                    icon={<Icon name="stop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                    label={props.pendingControl === 'cancel'
                        ? t('workflows.run.stopping')
                        : props.cancelRequested === true
                            ? t('workflows.run.stopAgain')
                            : t('workflows.run.stop')}
                    size="md"
                    style={styles.actionTarget}
                />
            ) : null}
            {overflowActions.length === 0 ? null : (
                <ItemRowActions
                    title={t('common.moreActions')}
                    actions={overflowActions}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    compactActionIds={[]}
                    overflowTriggerTestID={`${testIDPrefix}-overflow`}
                />
            )}
        </View>
    );

    const header = (
        <View style={styles.root}>
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
            <View
                testID={`${testIDPrefix}-outcome-region`}
                style={[styles.outcome, props.completionEmphasis === true ? styles.outcomeCompleted : null]}
                accessibilityRole="summary"
            >
                {props.completionEmphasis === true ? <View testID={`${testIDPrefix}-outcome-emphasis`} /> : null}
                {/* The status is said once, as the first words of this line (07 §3). */}
                <View style={styles.outcomeLine}>
                    <WorkflowRunStateMark state={props.run.state} testID={`${testIDPrefix}-outcome-mark`} />
                    <Text testID={`${testIDPrefix}-outcome`} style={styles.outcomeSentence}>
                        {outcomeLine}
                        {terminalOutcome?.kind === 'result_absent' ? ` ${t('workflows.finalOutput.none')}` : ''}
                    </Text>
                </View>
                {/* Contact loss is all that is known; resume choices come from
                    the recovery owner once the current state is. */}
                {props.machineReachable === false && !isTerminalWorkflowRunState(props.run.state) ? (
                    <Text testID={`${testIDPrefix}-machine-unavailable`} style={styles.provenance}>
                        {t('workflows.run.machineUnavailableBody')}
                    </Text>
                ) : null}

                {props.usageLabel === null || props.usageLabel === undefined ? null : (
                    <Text testID={`${testIDPrefix}-usage`} style={styles.metric}>{props.usageLabel}</Text>
                )}
                {/* One final-output row: either the selected result, or its
                    explicit absence once the Run has settled. Never both. */}
                {props.resultLabel === null || props.resultLabel === undefined ? null : (
                    <Text testID={`${testIDPrefix}-result`} style={styles.metric}>{props.resultLabel}</Text>
                )}

                {sourceSessionId !== null && props.onOpenSession !== undefined ? (
                    <View style={styles.actions}>
                        <HappierPressable
                            testID={`${testIDPrefix}-open-origin-session`}
                            accessibilityRole="button"
                            onPress={() => props.onOpenSession?.(sourceSessionId)}
                            style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
                        >
                            <Text style={styles.action}>{t('workflows.run.openSourceSession')}</Text>
                        </HappierPressable>
                    </View>
                ) : null}
                {props.notificationOperation}
                {/* The durable receipt, so the request survives its own
                    transport and names what it is waiting on. */}
                {props.cancelRequested === true && !isTerminalWorkflowRunState(props.run.state) ? (
                    <Text testID={`${testIDPrefix}-cancel-requested`} style={styles.provenance}>
                        {t('workflows.run.stopRequested', {
                            machine: props.machineName ?? props.run.machineId,
                        })}
                    </Text>
                ) : null}
                {props.deleteBlockedByCustody ? (
                    <Text testID={`${testIDPrefix}-custody-pending`} style={styles.provenance}>
                        {t('workflows.recovery.waitingForStop')}
                    </Text>
                ) : null}
                {props.errorLabel === null || props.errorLabel === undefined ? null : (
                    <Text
                        testID={`${testIDPrefix}-error`}
                        style={styles.provenance}
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
                        label={t('common.retry')}
                        onPress={props.onReload}
                        style={styles.actionTarget}
                        size="md"
                    />
                )}
            </View>

            {attentionRows.length === 0 ? null : (
                <View
                    testID={`${testIDPrefix}-needs-you`}
                    style={styles.section}
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
                    {/* One card of what needs the person, with the shared needs-you ring and tint. */}
                    <View style={[styles.attentionCard, workStatusSurfaceStyle('attention')]}>
                        {attentionRows.map((invocation, index) => {
                            const step = invocationLabel(invocation) ?? t('workflows.contentUnavailable');
                            const reviewing = invocation.id === props.selectedInvocationId;
                            const entry = derivedStructure.get(invocation.id);
                            const where = entry === undefined ? undefined : formatOccurrence(entry.occurrence);
                            return (
                                <View
                                    key={invocation.id}
                                    style={[styles.attentionRow, index > 0 ? styles.attentionRowDivided : null,
                                        reviewing ? styles.attentionRowSelected : null]}
                                >
                                    <Icon name="hand" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
                                    <View style={styles.attentionText}>
                                        <Text style={styles.attentionLabel} numberOfLines={2}>
                                            {attentionWaitsForYou(invocation)
                                                ? t('workflows.run.attentionWaitRow', { step })
                                                : t('workflows.run.attentionReviewRow', { step })}
                                        </Text>
                                        {where === undefined ? null : (
                                            <Text style={styles.attentionMeta} numberOfLines={1}>{where}</Text>
                                        )}
                                    </View>
                                    <ToolbarButton
                                        testID={`${testIDPrefix}-needs-you-${invocation.id}`}
                                        onPress={(event) => selectInvocation(invocation.id, event)}
                                        active={reviewing}
                                        label={reviewing ? t('workflows.run.reviewing') : t('workflows.run.review')}
                                        accessibilityLabel={`${t('workflows.run.review')}: ${step}`}
                                        size="md"
                                        style={styles.actionTarget}
                                    />
                                </View>
                            );
                        })}
                    </View>
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
            <View style={styles.viewSwitch}>
                <SegmentedTabBar
                    testIDPrefix={`${testIDPrefix}-view`}
                    accessibilityLabel={t('workflows.tabsAccessibility.runViews')}
                    segmentSizing="content"
                    tabs={[
                        { id: 'flow' as const, label: t('workflows.tabs.map') },
                        { id: 'steps' as const, label: t('workflows.tabs.steps') },
                        { id: 'activity' as const, label: t('workflows.tabs.activity') },
                    ]}
                    activeTabId={props.view}
                    onSelectTab={props.onChangeView}
                />
                {isTerminalWorkflowRunState(props.run.state) ? null : <ToolbarButton testID={`${testIDPrefix}-show-current-work`}
                    label={t('workflows.run.showCurrentWork')} size="md" style={styles.actionTarget}
                    disabled={currentWork === null}
                    onPress={(event) => { if (currentWork !== null) selectInvocation(currentWork.id, event); }} />}
                {props.sourceAction ? <ToolbarButton
                    testID={`${testIDPrefix}-${props.sourceAction.kind}-workflow`}
                    label={props.sourceAction.kind === 'edit' ? t('workflows.run.editWorkflow') : t('workflows.run.openWorkflow')}
                    size="md" style={styles.actionTarget} onPress={props.sourceAction.onPress}
                /> : props.hasSource !== true && props.onSaveAsWorkflow ? <HappierPressable
                    testID={`${testIDPrefix}-save-as-workflow`} accessibilityRole="button"
                    style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
                    onPress={props.onSaveAsWorkflow} disabled={props.saveAsWorkflowPending === true}
                    busy={props.saveAsWorkflowPending === true}
                ><Text style={styles.action}>{t('workflows.run.saveAsWorkflow')}</Text></HappierPressable> : null}
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
    const detailProps = React.useMemo((): WorkflowInvocationDetailProps | null => (
        props.selectedInvocationId === null ? null : {
            continuationText: selectedRecoveryText?.continuation,
            onChangeContinuationText: (next) => setSelectedRecoveryText('continuation', next),
            replacementText: selectedRecoveryText?.replacement,
            onChangeReplacementText: (next) => setSelectedRecoveryText('replacement', next),
            onSelectInvocation: selectInvocation,
            progress: props.selectedInvocationProgress ?? null,
            recovery,
            workspaceSourceLabel,
            cause: selectedInvocationCause,
            operationPending,
            testIDPrefix,
            ...(props.selectedContentUnavailable === undefined
                ? {}
                : { contentUnavailable: props.selectedContentUnavailable }),
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
        props.onRetryFreshAgent,
        props.onRetrySameConversation,
        props.onRetryWithReplacement,
        props.onStartReviewedNewRun,
        props.onRunWithAnotherAgent,
        props.pendingRequestIds,
        props.selectedContentUnavailable,
        props.selectedInvocationId,
        props.selectedInvocationProgress,
        props.uncertaintyAcknowledged,
        recovery,
        selectedInvocationCause,
        selectedRecoveryText,
        selectInvocation,
        setSelectedRecoveryText,
        testIDPrefix,
        workspaceSourceLabel,
    ]);
    const selectedDetailTitle = selectedInvocation === null
        ? t('workflows.run.untitled')
        : invocationLabel(selectedInvocation) ?? t('workflows.run.untitled');
    const selectedDetailSubtitle = React.useMemo(() => {
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
        const agentTarget = leaf?.selection.agentTarget;
        const targetKey = agentTarget == null ? null : resolveBackendTargetKeyV2(agentTarget);
        const identity = leaf?.role?.name ?? (targetKey === null ? null : presentEngine({ agentTargetKey: targetKey }).label ?? targetKey);
        const attempt = selectedInvocation?.attempt ?? props.selectedInvocationProgress?.attempt;
        const parts = [identity, entry === undefined ? undefined : formatOccurrence(entry.occurrence),
            attempt === undefined ? undefined : describeWorkflowInvocationAttempt(attempt).label];
        // Index timestamps include admission and updates; they are not an
        // authoritative execution duration, so this header does not invent one.
        return parts.filter((part): part is string => Boolean(part)).join(' · ') || null;
    }, [derivedStructure, formatOccurrence, presentEngine, props.definition, props.frozenChildren,
        props.materializedLeaves, props.selectedInvocationId, props.selectedInvocationProgress?.attempt, selectedInvocation?.attempt]);

    const selectedExecution = props.selectedInvocationProgress?.execution;
    const selectedKind = props.selectedInvocationProgress?.blockKind;
    const selectedSessionId = (selectedKind !== undefined && selectedKind !== 'step') || selectedExecution?.kind === 'detached_run' ? null
        : props.selectedSessionId !== undefined ? props.selectedSessionId
            : selectedExecution?.kind === 'session' ? selectedExecution.sessionId : null;
    const inspector = detailProps === null || props.selectedInvocationId === null ? null : <WorkflowSelectedDetail
        key={props.selectedInvocationId} detail={detailProps} sessionId={selectedSessionId}
        serverId={props.serverId} active={props.active !== false} phone={phone}
        title={selectedDetailTitle} subtitle={selectedDetailSubtitle} identity={props.selectedInvocationId}
        onClose={props.onDeselectInvocation}
        renderReviewCard={props.renderReviewCard} focusReturnRef={detailFocusReturnRef}
    />;

    const footer = (
        <View style={styles.root}>
            <View testID={`${testIDPrefix}-technical`} style={styles.section}>
                <HappierPressable
                    testID={`${testIDPrefix}-technical-toggle`}
                    accessibilityRole="button"
                    expanded={technicalOpen}
                    onPress={() => setTechnicalOpen((open) => !open)}
                    style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
                >
                    <Text style={styles.sectionLabel}>{t('workflows.run.technicalDetails')}</Text>
                </HappierPressable>
                {technicalOpen ? (
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
                ) : null}
            </View>
        </View>
    );

    const outline = props.view === 'steps' && props.definition !== null ? (
        <ScrollView testID={`${testIDPrefix}-steps`} style={styles.scroll}
            contentContainerStyle={[styles.root, props.contentContainerStyle]}>
            {header}
            <WorkflowRunSteps runId={props.run.id} machineId={props.run.machineId} serverId={props.serverId}
                definition={props.definition} invocations={props.invocations} structure={derivedStructure}
                frozenChildren={props.frozenChildren}
                selectedInvocationId={props.selectedInvocationId} onSelectInvocation={selectInvocation}
                occurrenceLabel={(entry) => formatOccurrence(entry.occurrence) ?? null}
                testIDPrefix={`${testIDPrefix}-steps`} />
            {props.onLoadMoreInvocations === undefined ? null : <WorkflowRunPagingAction
                testIDPrefix={`${testIDPrefix}-steps`} onLoadMore={props.onLoadMoreInvocations}
                loading={props.loadingMoreInvocations === true} failed={props.loadMoreInvocationsFailed === true} />}
            {footer}
        </ScrollView>
    ) : props.view === 'activity' || flowProjection === null ? (
        <WorkflowInvocationList
            listRef={activityListRef}
            onScroll={captureActivityScroll}
            testIDPrefix={`${testIDPrefix}-invocations`}
            invocations={activityInvocations}
            loaded={props.invocationsLoaded}
            selectedInvocationId={props.selectedInvocationId}
            onSelectInvocation={selectInvocation}
            resolveInvocationLabel={invocationLabel}
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
            <WorkflowFlowView
                testIDPrefix={`${testIDPrefix}-flow`}
                projection={flowProjection}
                selectedNodeId={props.selectedInvocationId === null
                    ? null
                    : derivedStructure.get(props.selectedInvocationId)?.nodeId ?? null}
                selectedInvocationId={props.selectedInvocationId}
                onSelectOccurrence={selectInvocation}
                agentMarkForNode={agentMarkForNode}
                {...(flowRunStates === undefined ? {} : { runStates: flowRunStates })}
            />
            {footer}
        </ScrollView>
    );

    if (!detailsPaneAvailable && props.invocationPage && inspector !== null) return inspector;
    const main = <View style={[styles.outline, maxWidthStyle]}>{outline}</View>;
    if (!detailsPaneAvailable) return main;
    return <DetailsPaneHost main={main}
        details={inspector === null ? null : { content: inspector, header: { title: selectedDetailTitle, subtitle: selectedDetailSubtitle }, accessibilityLabel: selectedDetailTitle }}
        onCloseDetails={() => props.onDeselectInvocation?.()} />;
}
