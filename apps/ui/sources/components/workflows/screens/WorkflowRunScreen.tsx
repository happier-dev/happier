import * as React from 'react';
import { View } from 'react-native';
import { useDestinationParams, useDestinationRouter, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { randomUUID } from 'expo-crypto';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    JsonValue,
    WorkflowAuthoredInputV1,
    WorkflowProgressEnvelopeV1,
    WorkflowInvocationRecoveryAvailabilityV1,
    WorkflowRunSummaryV1,
    WorkflowReplayAgentOverrideV1,
} from '@happier-dev/protocol';
import { ArtifactAccessGrantsListResponseV1Schema, WorkflowResultContractSchema } from '@happier-dev/protocol';
import { parseWorkflowDefinitionRefV1, resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { readWorkflowPlanResult } from '@/sync/domains/workflows/workflowPlanReview';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { WorkflowProjectTargetControl, formatWorkflowWhereSummary } from '../editor/WorkflowProjectTargetControl';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import { t } from '@/text';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { getStorage, useActiveServerAccountScope, useArtifact, useMachine, useWorkflowRun } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    isWorkflowInvocationFactOlder,
    refreshLoadedAttentionSpan,
    resolveVisibleWorkflowInvocations,
    selectWorkflowRunFirstFailedInvocation,
    selectWorkflowRunWindowInvocations,
    workflowRunRowFromSummary,
} from '@/sync/store/domains/workflowRuns';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

import {
    WorkflowRunContent,
    type WorkflowRunDetailView,
    type WorkflowRunOperationKind,
} from '../run/WorkflowRunContent';
import {
    isWorkflowWorkspaceUnavailableReason,
    projectWorkflowInvocationRecovery,
    requiresUncertainPriorEffectsAcknowledgement,
    type WorkflowRecoveryContinuation,
} from '../run/workflowRunDetailPresentation';
import { isTerminalWorkflowRunState } from '../presentation/workflowLifecyclePresentation';
import { projectWorkflowInvocationStructure } from '../run/workflowInvocationStructure';
import { hasWorkflowInvocationRequest } from '../run/workflowPermissionRequests';
import {
    buildWorkflowReviewedRunSeed,
    storeWorkflowReviewedRunSeed,
} from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { useWorkflowCompletionMoment } from '../run/useWorkflowCompletionMoment';
import { useWorkflowAnnouncements } from '../accessibility/useWorkflowAnnouncements';
import type { WorkflowAnnouncementTerminalKind } from '../accessibility/workflowAnnouncementSelection';
import {
    WORKFLOW_ATTENTION_LIFECYCLES,
    summarizeWorkflowInvocationCoverage,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { useWorkflowRunNowController } from '../run/useWorkflowRunNowController';
import {
    useWorkflowRunComposerModal,
    type WorkflowRunComposerModalProps,
} from '../run/useWorkflowRunComposerModal';
import { projectAcceptedWorkflowRunTarget } from '../run/projectAcceptedWorkflowRunTarget';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowRunAgentOverrideField } from '../run/WorkflowRunAgentOverrideField';
import { createMachineExecutionRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import {
    resolveWorkflowProblemPresentation,
    type WorkflowProblemPresentation,
} from '@/components/workflows/presentation/workflowProblemPresentation';
import { readWorkflowInvocationId, readWorkflowRunId } from '@/sync/domains/workflows/workflowRunRoute';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { normalizeResultPreview } from '../presentation/resultPreview';
import { formatWorkflowUsageLabel } from '../presentation/workflowUsagePresentation';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '../presentation/workflowRunDisplayName';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { ExecutionRunPromptResponse } from '@/components/tools/shell/permissions/executionRunPromptResponseTarget';
import { RunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { createWorkflowDefinitionRoute, createWorkflowInvocationRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { WorkflowInvocationReview, type WorkflowInvocationReviewBuffers } from '../run/WorkflowInvocationReview';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';

/**
 * The exact managed Run route.
 *
 * It resolves its Run from the one Account-scoped `workflowRunsById` owner by
 * `runId`, so a deep link, a list tap, an agent result and the Automation
 * provenance wrapper all render one body. The screen owns route state only —
 * selected invocation, view, in-flight command — never a second lifecycle
 * interpretation.
 */

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
    },
}));

const EMPTY_PROGRESS_BY_INVOCATION_ID: ReadonlyMap<string, WorkflowProgressEnvelopeV1> = new Map();
type ActiveAccountScopeLifetime = NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>>;
type ExactInvocationResponse = Awaited<ReturnType<typeof workflowRunDetailActions.getInvocation>>;

type PendingPermissionDecision = Readonly<{
    accountLifetime: ActiveAccountScopeLifetime;
    contentIdentity: string;
    runId: string;
    invocationId: string;
    executionRunId: string;
    requestId: string;
}>;

const EMPTY_PERMISSION_DECISIONS: ReadonlyMap<string, PendingPermissionDecision> = new Map();
const EMPTY_PERMISSION_REQUEST_IDS: ReadonlySet<string> = new Set();

/**
 * The exact invocation read this screen has issued and not seen settle.
 *
 * The selected row keeps its last-known content visible while the read is in
 * flight, but no permission or recovery callback may act on it until the
 * matching response confirms it. This token is the issuing authority: only
 * the latest issued read for this Account, Run and selection may publish and
 * confirm, so a response that lost its race is ignored rather than
 * regressing fresher content or arming callbacks from superseded evidence.
 * The record id is the physical attempt's identity, so matching it plus a
 * parent revision at least as fresh as the issued one is the complete match.
 */
type PendingExactInvocationRead = Readonly<{
    contentIdentity: string;
    runId: string;
    invocationId: string;
    revision: number;
    contentRevision: string | null;
}>;

/**
 * The one durable Run operation this screen has issued and not seen settle.
 *
 * Every durable operation — pause, resume, cancel, retry, continuation,
 * reattach, workspace restoration, deletion — carries the Run's
 * `expectedRevision`, so two in flight at once are a currentness race the
 * person did not ask for. This token is the mutex: it is taken at issuance,
 * scoped to the exact Account and Run it was issued for, and released only by
 * the operation that took it. A settlement that arrives after the token moved
 * on belongs to nobody on screen and cannot overwrite a newer result.
 */
type PendingRunOperation = Readonly<{
    kind: WorkflowRunOperationKind;
    contentIdentity: string;
}>;

/**
 * A continuation page that could not be appended, for exactly one Account, Run
 * and window.
 *
 * It is presentation state, not a durable Run operation failure: the window
 * keeps every row it already read and the cursor Retry needs, so Retry asks for
 * the same next page again rather than reloading the Run. Routed through
 * `controlError` it borrowed the outcome region's voice, outlived the page it
 * described and was cleared by the next unrelated control — this is the same
 * shape the Workflows library reads use (`workflowLibraryReads`). Keying
 * it by the content identity is what retires it with everything else private to
 * this Run when the Account or the Run changes.
 */
type WorkflowRunPagingFailure = Readonly<{
    contentIdentity: string;
    window: 'history' | 'attention';
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The exact identity of a permission request.
 *
 * The daemon settles a request against its execution Run, so a request id is
 * unique only inside that Run. Keying the decision by both is what keeps a
 * withdrawn control — and its settlement — attached to the request the person
 * actually answered rather than a same-named one on another attempt.
 */
function permissionRequestKey(executionRunId: string, requestId: string): string {
    return `${executionRunId}\u0000${requestId}`;
}

function isDefinitivePermissionDecisionPreIssuanceResponse(response: Readonly<{
    ok: boolean;
    errorCode?: string;
}>): boolean {
    if (response.ok) return false;
    return response.errorCode === 'execution_run_target_unavailable';
}

function resolveAnnouncementTerminal(
    state: WorkflowRunSummaryV1['state'],
    knownFailure: boolean,
): WorkflowAnnouncementTerminalKind | null {
    switch (state) {
        case 'succeeded': return knownFailure ? 'completed_with_failures' : 'completed';
        case 'failed': return 'failed';
        case 'outcome_uncertain': return 'outcome_uncertain';
        case 'paused': return 'paused';
        case 'interrupted': return 'interrupted';
        default: return null;
    }
}

export function WorkflowRunScreen(): React.ReactElement {
    const { theme } = useUnistyles();
    const contentStyle = React.useMemo(() => ({
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.lg,
        gap: theme.margins.lg,
    }), [theme.margins.lg]);
    const mountedRef = useMountedRef();
    const router = useDestinationRouter();
    const openProject = useOpenProject();
    const hostActivelyViewed = useHostActivelyViewed();
    const destinationVisible = useDestinationVisibility();
    const activelyViewed = hostActivelyViewed && destinationVisible;
    const runNow = useWorkflowRunNowController();
    const detailsPaneAvailable = useDetailsPaneAvailable();
    const params = useDestinationParams<{ runId?: string | string[]; invocationId?: string | string[] }>();
    const runId = readWorkflowRunId(firstParam(params.runId));
    const requestedInvocationId = readWorkflowInvocationId(firstParam(params.invocationId));
    const activeAccountScope = useActiveServerAccountScope();
    const accountScopeKey = activeAccountScope === null
        ? null
        : serverAccountScopeKeySuffix(activeAccountScope);

    // The shared row has no embedded Account tag: do not expose it until the
    // exact read establishes that it belongs to this mounted Account scope.
    // This also fails closed when the same opaque Run id exists in two Accounts.
    //
    // Ownership is the Account *and* the Run, because this screen stays mounted
    // across a Run change. Keyed on the Account alone, everything private below
    // — definition, accepted context, result, progress, attention rows, the
    // selection and the acknowledgement — stayed on screen from the previous Run
    // and combined with the next Run's already-cached lifecycle row, which is
    // how Run A's steps and actions appeared under Run B's status.
    const cachedRow = useWorkflowRun(runId);
    const contentIdentity = `${accountScopeKey ?? ''}\u0000${runId ?? ''}`;
    const contentIdentityRef = React.useRef(contentIdentity);
    contentIdentityRef.current = contentIdentity;
    const isContentIdentityCurrent = React.useCallback(
        (expectedIdentity: string) => mountedRef.current && contentIdentityRef.current === expectedIdentity,
        [mountedRef],
    );
    const [contentScopeKey, setContentScopeKey] = React.useState<string | null>(null);
    const reviewBuffers = React.useMemo<WorkflowInvocationReviewBuffers>(() => ({ drafts: new Map(), readings: new Map() }), [contentIdentity]);
    const contentScopeKeyRef = React.useRef(contentScopeKey);
    contentScopeKeyRef.current = contentScopeKey;
    const [firstFailedInvocationResolution, setFirstFailedInvocationResolution] = React.useState<'loading' | 'resolved' | 'error'>('loading');
    const detail = cachedRow?.detail;
    const definition = detail?.definition ?? null;
    const acceptedContext = detail?.acceptedContext ?? null;
    const result = detail?.result;
    const finalOutputInvocationId = detail?.finalOutputInvocationId ?? null;
    const usageLabel = detail?.usage === undefined ? null : formatWorkflowUsageLabel(detail.usage, {
        tokens: t('usage.tokens'), input: t('usage.tokenMix.input'), output: t('usage.tokenMix.output'),
    });
    /** How many attention pages produced the loaded span; bounds the background refresh. */
    const attentionPageCountRef = React.useRef(0);
    // Private content and its row token are one exact observation, never
    // separately refreshed maps that could arm a new row with an old blob.
    const invocationFacts = getStorage()((state) => activelyViewed && runId
        ? state.workflowRunInvocationsByRunId[runId]?.factsById ?? null : null);
    const invocationEvidenceById = React.useMemo(() => new Map(Object.entries(invocationFacts ?? {}).flatMap(
        ([id, fact]) => fact.opened ? [[id, fact.opened] as const] : [],
    )), [invocationFacts]);
    const progressByInvocationId = React.useMemo(() => new Map(
        [...invocationEvidenceById].map(([id, evidence]) => [id, evidence.progress]),
    ), [invocationEvidenceById]);
    const recoveryAvailabilityByInvocationId = React.useMemo(() => {
        const next = new Map<string, WorkflowInvocationRecoveryAvailabilityV1>();
        for (const [id, evidence] of invocationEvidenceById) {
            if (evidence.recoveryAvailability) next.set(id, evidence.recoveryAvailability);
        }
        return next;
    }, [invocationEvidenceById]);
    const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    /**
     * Asking for the Run again.
     *
     * A failed first read is not proof the Run is gone, and the person had no
     * way to ask again: the effect only re-runs when the Account, the Run or the
     * cached revision changes, none of which a transport failure produces. This
     * is the same explicit attempt counter the editor and Session adapters use.
     */
    const [loadAttempt, setLoadAttempt] = React.useState(0);
    const [invocationInvalidationToken, setInvocationInvalidationToken] = React.useState(0);
    const [view, setView] = React.useState<WorkflowRunDetailView>('activity');
    const [selectedInvocationId, setSelectedInvocationId] = React.useState<string | null>(requestedInvocationId);
    const [pendingOperation, setPendingOperation] = React.useState<PendingRunOperation | null>(null);
    /**
     * The issuing authority for the mutex. Two presses can land in one frame,
     * so a guard reading rendered state would admit both; the ref refuses the
     * second before anything is sent.
     */
    const pendingOperationRef = React.useRef<PendingRunOperation | null>(null);
    const [loadingMoreInvocations, setLoadingMoreInvocations] = React.useState(false);
    const [loadingMoreAttention, setLoadingMoreAttention] = React.useState(false);
    /**
     * The attention continuation this screen has issued and not seen settle.
     *
     * Two presses land in one frame, so a guard reading rendered state would
     * admit both and send the same cursor twice — two responses merging the
     * same rows and racing each other's `nextCursor`. This is the same token
     * mutex the durable Run operations use: it is taken at issuance and
     * released only by the request that took it.
     */
    const pendingAttentionPageRef = React.useRef<object | null>(null);
    const [pagingFailure, setPagingFailure] = React.useState<WorkflowRunPagingFailure | null>(null);
    const [controlError, setControlError] = React.useState<WorkflowProblemPresentation | null>(null);
    /**
     * A cancellation this screen submitted and the canonical owner accepted.
     *
     * It covers the window before the invocation index reports the durable
     * `cancel_requested` rows; from then on that index is the authority and
     * this only agrees with it.
     */
    const [cancelRequestReceipt, setCancelRequestReceipt] = React.useState(false);
    /**
     * The permission decisions this screen has sent and not seen settle.
     *
     * The mirror ref is the issuing authority: two presses land in one frame,
     * so a guard reading rendered state would let the opposite decision race
     * the one already in flight. Nothing is settled here — the machine's
     * execution owner records the answer and the canonical read reports it.
     */
    const [pendingPermissionDecisions, setPendingPermissionDecisions] = React.useState<ReadonlyMap<string, PendingPermissionDecision>>(EMPTY_PERMISSION_DECISIONS);
    const pendingPermissionDecisionsRef = React.useRef(pendingPermissionDecisions);
    /** The latest exact invocation read; older responses belong to nobody on screen. */
    const exactInvocationRequestRef = React.useRef<PendingExactInvocationRead | null>(null);
    const [selectedReadUnavailable, setSelectedContentUnavailable] = React.useState(true);
    const [runAgainInputOpen, setRunAgainInputOpen] = React.useState(false);
    const [runAgainAgentOverride, setRunAgainAgentOverride] = React.useState<
        (Omit<WorkflowReplayAgentOverrideV1, 'engine'> & { engine?: WorkflowReplayAgentOverrideV1['engine']; step: string }) | null
    >(null);
    const [runAgainValues, setRunAgainValues] = React.useState<Readonly<Record<string, JsonValue | undefined>>>({});
    const [runAgainRawTextValues, setRunAgainRawTextValues] = React.useState<Readonly<Record<string, string>>>({});
    /**
     * The exact attempt whose unknown prior effects the person acknowledged.
     * Both the row and content revision are pinned, so a newer publication or
     * a different invocation cannot silently inherit this acknowledgement.
     */
    const [acknowledgedUncertainInvocation, setAcknowledgedUncertainInvocation] = React.useState<Readonly<{
        recordId: string;
        contentRevision: string;
    }> | null>(null);
    const pendingRunAgainIdRef = React.useRef<string | null>(null);
    /** Which (Run, Account) pair the shared row currently holds, for exact retirement. */
    const loadedRunAccountScopeRef = React.useRef<Readonly<{ runId: string; accountScopeKey: string | null }> | null>(null);
    /**
     * What the last completed load observed, so a background invalidation knows
     * whether it still has to open the Run's private half at all.
     */
    const loadedDetailRef = React.useRef<Readonly<{
        contentIdentity: string;
        revision: number | null;
        terminal: boolean;
    }> | null>(null);
    /**
     * The lifecycle each invocation had at the last committed observation, and
     * whether announcements have a baseline yet. Both belong to one Run: carried
     * across a Run change they turn B's first load into "these rows just changed".
     */
    const previousLifecyclesRef = React.useRef<ReadonlyMap<string, string>>(new Map());
    const [announcementsEnabled, setAnnouncementsEnabled] = React.useState(false);

    /**
     * A different Run (or Account) takes over this mounted screen immediately.
     *
     * Withdrawing during render rather than when the next read resolves is the
     * whole point: between navigation and that response there is a window where
     * the previous Run's private detail would otherwise be rendered beside the
     * new Run's cached lifecycle row, and its still-live actions would address
     * the new Run.
     */
    const [observedContentIdentity, setObservedContentIdentity] = React.useState(contentIdentity);
    if (observedContentIdentity !== contentIdentity) {
        setObservedContentIdentity(contentIdentity);
        setContentScopeKey(null);
        contentScopeKeyRef.current = null;
        attentionPageCountRef.current = 0;
        // Nothing about the next Run is confirmed yet; the exact read marks
        // it so before requesting rather than exposing armed callbacks for a
        // frame beside the new Run's cached lifecycle row.
        exactInvocationRequestRef.current = null;
        setSelectedContentUnavailable(true);
        pendingOperationRef.current = null;
        setPendingOperation(null);
        setControlError(null);
        setCancelRequestReceipt(false);
        setPendingPermissionDecisions(EMPTY_PERMISSION_DECISIONS);
        pendingPermissionDecisionsRef.current = EMPTY_PERMISSION_DECISIONS;
        setLoadingMoreInvocations(false);
        pendingAttentionPageRef.current = null;
        setLoadingMoreAttention(false);
        setPagingFailure(null);
        setRunAgainInputOpen(false);
        setRunAgainValues({});
        setRunAgainRawTextValues({});
        setAcknowledgedUncertainInvocation(null);
        setSelectedInvocationId(requestedInvocationId);
        setView('activity');
        setLoadState('loading');
        pendingRunAgainIdRef.current = null;
        previousLifecyclesRef.current = new Map();
        loadedDetailRef.current = null;
        setAnnouncementsEnabled(false);
    }

    // The Run's one invocation fact map and the windows over it (03 §6.2); this
    // screen holds no fact copies, only route paging state.
    const storedInvocations = getStorage()((state) => (activelyViewed && runId ? state.workflowRunInvocationsByRunId[runId] ?? null : null));
    const contentBelongsToActiveScope = contentScopeKey === contentIdentity;
    const visibleInvocations = contentBelongsToActiveScope ? storedInvocations : null;
    const invocationWindow = visibleInvocations?.history ?? null;
    const attentionNextCursor = visibleInvocations?.attention.nextCursor ?? null;

    const observedRevision = cachedRow?.summary?.revision ?? null;
    const observedTerminal = cachedRow?.summary === undefined || cachedRow.summary === null
        ? false
        : isTerminalWorkflowRunState(cachedRow.summary.state);
    /**
     * A revision this screen has published but not yet read.
     *
     * The load cannot simply depend on the shared row's revision: its own read
     * writes that row, so the first load would immediately retire itself and
     * start over. Until a load records what it observed there is nothing to
     * refresh — the load in progress is what will read it — and once one has,
     * only a revision it has not seen re-triggers the effect.
     */
    const loadedDetail = loadedDetailRef.current;
    const pendingRefreshRevision = loadedDetail !== null
        && loadedDetail.contentIdentity === contentIdentity
        && loadedDetail.revision !== observedRevision
        ? observedRevision
        : null;

    React.useEffect(() => {
        if (!activelyViewed || runId === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            runId,
            // Detail is demanded even while its first read is in flight. A
            // row wake must retire that read rather than publish stale facts.
            isVisibleWindowLoaded: () => true,
            invalidate: () => setInvocationInvalidationToken((token) => token + 1),
        });
    }, [accountScopeKey, activelyViewed, runId]);

    React.useEffect(() => {
        if (!activelyViewed || runId === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        const requestScopeKey = contentIdentity;
        /**
         * A background invalidation restates what changed; it does not reopen
         * the Run.
         *
         * The private half of Run detail is frozen at admission — definition,
         * accepted context, inputs — except for the result, its exact producer
         * and usage, which a Run writes once when it settles. Re-reading all of
         * it on every revision bump made an ordinary progress update scan and
         * decrypt the whole Run, and replaced the loaded index pages with their
         * first page. The canonical Account-change owner has already refreshed
         * the shared summary row this screen renders from.
         */
        const isBackgroundRefresh = loadedDetail !== null && loadedDetail.contentIdentity === contentIdentity;
        const needsExactDetail = !isBackgroundRefresh
            || (observedTerminal && loadedDetail?.terminal === false);
        let cancelled = false;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        setLoadState((current) => (
            contentScopeKeyRef.current === requestScopeKey && current === 'ready'
                ? current
                : 'loading'
        ));
        if (!isBackgroundRefresh) setFirstFailedInvocationResolution('loading');

        void (async () => {
            try {
                let detail: Awaited<ReturnType<typeof workflowRunDetailActions.getRun>> | null = null;
                if (needsExactDetail) {
                    detail = await workflowRunDetailActions.getRun(runId, controller.signal);
                    if (cancelled || !lifetime.isCurrent() || !isContentIdentityCurrent(requestScopeKey)) return;
                    if (loadedRunAccountScopeRef.current !== null
                        && loadedRunAccountScopeRef.current.runId === runId
                        && loadedRunAccountScopeRef.current.accountScopeKey !== accountScopeKey) {
                        // The same opaque id exists in both Accounts, so the shared
                        // row itself is the other Account's. Retire it before the
                        // new body merges into the one owner.
                        getStorage().getState().removeWorkflowRun(runId);
                    }
                    // The body lands in the one shared owner; this screen keeps no copy.
                    //
                    // An opened accepted context that carries no authored title
                    // is an untitled Run, not private content this device could
                    // not open: the sparse metadata sidecar omits the key when
                    // the snapshot is readable but unnamed, and projecting that
                    // as `unavailable` locked a perfectly readable Run in the
                    // collection and in every Session card that reads the same row.
                    getStorage().getState().upsertWorkflowRuns([{ ...workflowRunRowFromSummary(
                        detail.run,
                        detail.acceptedContext.metadata
                            ? { kind: 'available', value: detail.acceptedContext.metadata }
                            : null,
                    ), detail }]);
                    setContentScopeKey(requestScopeKey);
                    loadedRunAccountScopeRef.current = { runId, accountScopeKey };
                }

                // What this pass actually observed, which is the read's own
                // answer whenever it opened the Run. Recording the revision the
                // render happened to hold would leave the ref behind the row it
                // just published and make the next render repeat the whole load.
                const observedState = detail === null
                    ? { revision: observedRevision, terminal: observedTerminal }
                    : { revision: detail.run.revision, terminal: isTerminalWorkflowRunState(detail.run.state) };

                const historyPromise = workflowRunDetailActions.listInvocations({ runId }, controller.signal);
                const failedPromise = observedState.terminal
                    ? workflowRunDetailActions.listInvocations({ runId, lifecycles: ['failed'], limit: 1 }, controller.signal)
                    : Promise.resolve(null);
                if (isBackgroundRefresh) {
                    // Refresh the complete loaded filtered span, not only its
                    // first page. The helper replays the traversal the reader
                    // paid for through the existing pagination API, bounded by
                    // its loaded page count, so a settled tail beyond page one
                    // leaves and the continuation reflects current truth.
                    const [page, failedPage, refreshedAttention] = await Promise.all([
                        historyPromise,
                        failedPromise,
                        refreshLoadedAttentionSpan({
                            listPage: ({ cursor }) => workflowRunDetailActions.listInvocations({
                                runId,
                                ...(cursor === undefined ? {} : { cursor }),
                                lifecycles: WORKFLOW_ATTENTION_LIFECYCLES,
                            }, controller.signal),
                            previousPageCount: Math.max(1, attentionPageCountRef.current),
                            signal: controller.signal,
                        }),
                    ]);
                    if (cancelled || !lifetime.isCurrent() || !isContentIdentityCurrent(requestScopeKey)) return;
                    const store = getStorage().getState();
                    store.applyWorkflowRunInvocationPage({
                        runId,
                        invocations: page.invocations,
                        nextCursor: page.nextCursor ?? null,
                        parentRevision: page.parentRevision,
                        mode: 'refresh',
                    });
                    store.applyWorkflowRunInvocationPage({
                        runId,
                        window: 'attention',
                        invocations: refreshedAttention.invocations,
                        nextCursor: refreshedAttention.nextCursor,
                        parentRevision: refreshedAttention.parentRevision ?? page.parentRevision,
                        mode: 'refresh',
                    });
                    store.setWorkflowRunFirstFailedInvocation({ runId, invocation: failedPage?.invocations[0] ?? null });
                    setFirstFailedInvocationResolution('resolved');
                    loadedDetailRef.current = {
                        contentIdentity: requestScopeKey,
                        revision: observedState.revision,
                        terminal: observedState.terminal,
                    };
                    setPagingFailure(null);
                    setLoadState('ready');
                    return;
                }

                const [page, attentionPage, failedPage] = await Promise.all([
                    historyPromise,
                    workflowRunDetailActions.listInvocations({ runId, lifecycles: WORKFLOW_ATTENTION_LIFECYCLES }, controller.signal),
                    failedPromise,
                ]);
                if (cancelled || !lifetime.isCurrent() || !isContentIdentityCurrent(requestScopeKey)) return;
                const store = getStorage().getState();
                store.applyWorkflowRunInvocationPage({
                    runId,
                    invocations: page.invocations,
                    nextCursor: page.nextCursor ?? null,
                    parentRevision: page.parentRevision,
                    mode: 'replace',
                });
                store.applyWorkflowRunInvocationPage({
                    runId,
                    window: 'attention',
                    invocations: attentionPage.invocations,
                    nextCursor: attentionPage.nextCursor ?? null,
                    parentRevision: attentionPage.parentRevision,
                    mode: 'replace',
                });
                attentionPageCountRef.current = 1;
                store.setWorkflowRunFirstFailedInvocation({ runId, invocation: failedPage?.invocations[0] ?? null });
                setFirstFailedInvocationResolution('resolved');
                loadedDetailRef.current = {
                    contentIdentity: requestScopeKey,
                    revision: observedState.revision,
                    terminal: observedState.terminal,
                };
                // Fresh first pages supersede a failed continuation of the ones
                // they replaced.
                setPagingFailure(null);
                setLoadState('ready');
            } catch {
                if (cancelled || !lifetime.isCurrent() || !isContentIdentityCurrent(requestScopeKey)) return;
                setFirstFailedInvocationResolution('error');
                // Last-known-good detail stays visible, but readiness remains
                // truthful until both public invocation windows have loaded.
                setLoadState('failed');
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            retirement.dispose();
        };
        // `observedRevision`/`observedTerminal` are deliberately not dependencies:
        // they are read from the render that produced `pendingRefreshRevision`,
        // and depending on them directly would restart the whole load whenever
        // the shared row moved for a reason this screen has already read.
    }, [accountScopeKey, activelyViewed, contentIdentity, invocationInvalidationToken, isContentIdentityCurrent, loadAttempt, pendingRefreshRevision, runId]);

    const retryLoad = React.useCallback(() => {
        setLoadState('loading');
        setLoadAttempt((attempt) => attempt + 1);
    }, []);

    const summary: WorkflowRunSummaryV1 | null = contentBelongsToActiveScope
        ? cachedRow?.summary ?? null
        : null;
    const runMachine = useMachine(summary?.machineId ?? '', summary !== null);
    const visibleDefinition = contentBelongsToActiveScope ? definition : null;
    const visibleAcceptedContext = contentBelongsToActiveScope ? acceptedContext : null;
    const callerAccess = contentBelongsToActiveScope ? detail?.callerAccess : undefined;
    const canEdit = callerAccess?.canEdit === true;
    const acceptedSource = visibleAcceptedContext?.source;
    const sourceArtifactId = summary?.sourceArtifactId ?? (
        acceptedSource?.kind === 'saved' || acceptedSource?.kind === 'automation'
            ? acceptedSource.definitionId ?? null
            : null
    );
    const catalogSourceRef = acceptedSource?.kind === 'catalog' ? acceptedSource.ref : null;
    const sourceRef = sourceArtifactId ?? catalogSourceRef;
    const hasSource = sourceRef !== null;
    const catalogSource = sourceArtifactId === null ? parseWorkflowDefinitionRefV1(catalogSourceRef) : null;
    const pluginSourceActive = activelyViewed && accountScopeKey !== null && catalogSource?.kind === 'plugin';
    const sourceLibrary = useWorkflowDefinitionLibrary({ enabled: pluginSourceActive });
    const pluginSourcePresent = sourceLibrary.status === 'loaded'
        && sourceLibrary.pluginWorkflows.some((entry) => entry.workflow === catalogSourceRef);
    const sourceAvailable = sourceArtifactId !== null
        || (catalogSource?.kind === 'builtin' && resolveBuiltinWorkflowDefinitionV1(catalogSource.id) !== null)
        || (catalogSource?.kind === 'plugin' && pluginSourcePresent);
    // The catalog viewer uses this same paged owner; an absent first-page
    // entry is not yet proof that a plugin source is unavailable.
    React.useEffect(() => {
        if (pluginSourceActive && !pluginSourcePresent && sourceLibrary.status === 'loaded'
            && sourceLibrary.hasMore && !sourceLibrary.loadingMore && !sourceLibrary.loadMoreFailed) {
            sourceLibrary.loadMore();
        }
    }, [pluginSourceActive, pluginSourcePresent, sourceLibrary.status, sourceLibrary.hasMore,
        sourceLibrary.loadingMore, sourceLibrary.loadMoreFailed, sourceLibrary.loadMore]);
    // Artifact content updates and removals invalidate this source's observed
    // rights; the grant Action, rather than Run control access or cached content,
    // confirms that the source still exists and which action is available.
    const sourceArtifact = useArtifact(activelyViewed ? sourceArtifactId ?? '' : '');
    const sourceIdentity = `${contentIdentity}\u0000${sourceRef ?? ''}`;
    const currentSourceRef = React.useRef({ identity: sourceIdentity, artifact: sourceArtifact, active: activelyViewed, available: sourceAvailable });
    currentSourceRef.current = { identity: sourceIdentity, artifact: sourceArtifact, active: activelyViewed, available: sourceAvailable };
    const [executeSourceAction] = React.useState(() => createFrontDoorActionExecute());
    const [sourceObservation, setSourceObservation] = React.useState<Readonly<{
        identity: string;
        artifact: typeof sourceArtifact;
        lifetime: ActiveAccountScopeLifetime;
        action: Readonly<{ kind: 'edit' | 'open'; onPress(): void }>;
    }> | null>(null);
    React.useEffect(() => {
        setSourceObservation(null);
        if (!activelyViewed || accountScopeKey === null || sourceRef === null || !sourceAvailable) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        let cancelled = false;
        const controller = new AbortController();
        const isCurrent = () => !cancelled && mountedRef.current && lifetime.isCurrent()
            && currentSourceRef.current.active && currentSourceRef.current.available && currentSourceRef.current.identity === sourceIdentity
            && currentSourceRef.current.artifact === sourceArtifact;
        const retirement = lifetime.onRetire(() => {
            controller.abort();
            if (mountedRef.current) setSourceObservation(null);
        });
        const publish = (kind: 'edit' | 'open') => {
            if (!isCurrent()) return;
            setSourceObservation({ identity: sourceIdentity, artifact: sourceArtifact, lifetime,
                action: { kind, onPress: () => {
                    if (isCurrent()) router.push(createWorkflowDefinitionRoute(sourceRef) as never);
                } } });
        };
        if (sourceArtifactId === null) {
            publish('open');
        } else {
            void executeSourceAction('artifact.access.grants.list', { artifactId: sourceArtifactId }, {
                surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                signal: controller.signal,
            }).then((response) => {
                if (!isCurrent() || !response.ok) return;
                const parsed = ArtifactAccessGrantsListResponseV1Schema.safeParse(response.result);
                if (!parsed.success || parsed.data.artifactId !== sourceArtifactId) return;
                publish(parsed.data.access === 'view' ? 'open' : 'edit');
            }).catch(() => {});
        }
        return () => {
            cancelled = true;
            controller.abort();
            retirement.dispose();
        };
    }, [accountScopeKey, activelyViewed, executeSourceAction, loadAttempt, mountedRef, router, sourceArtifact, sourceArtifactId, sourceAvailable, sourceIdentity, sourceRef]);
    const sourceAction = activelyViewed && sourceAvailable && sourceObservation?.identity === sourceIdentity
        && sourceObservation.artifact === sourceArtifact && sourceObservation.lifetime.isCurrent()
        ? sourceObservation.action : null;
    const visibleResult = contentBelongsToActiveScope ? result : undefined;
    const visibleFinalOutputInvocationId = contentBelongsToActiveScope ? finalOutputInvocationId : null;
    const visibleFirstFailedInvocation = selectWorkflowRunFirstFailedInvocation(visibleInvocations);
    const visibleUsageLabel = contentBelongsToActiveScope ? usageLabel : null;
    const visibleAttentionInvocations = selectWorkflowRunWindowInvocations(visibleInvocations, 'attention');
    const visibleProgressByInvocationId = contentBelongsToActiveScope
        ? progressByInvocationId
        : EMPTY_PROGRESS_BY_INVOCATION_ID;
    const allInvocations = resolveVisibleWorkflowInvocations(visibleInvocations);
    const visibleResultLabel = React.useMemo(() => {
        if (visibleResult === undefined) return null;
        const raw = typeof visibleResult === 'string' ? visibleResult : JSON.stringify(visibleResult);
        return normalizeResultPreview(raw).display;
    }, [visibleResult]);
    // A deep link selects an invocation; losing that query releases the selection
    // it made. Without this the previous link's row stayed selected — and after a
    // Run change it named a row this Run does not have.
    const requestedInvocationIdRef = React.useRef(requestedInvocationId);
    React.useEffect(() => {
        const previousRequested = requestedInvocationIdRef.current;
        requestedInvocationIdRef.current = requestedInvocationId;
        if (requestedInvocationId !== null) setSelectedInvocationId(requestedInvocationId);
        else if (previousRequested !== null) setSelectedInvocationId(null);
    }, [requestedInvocationId]);
    // One navigable identity map for Activity, Flow and the exact selection, so
    // a row that has never been opened still knows which authored node and
    // occurrence it is without decrypting anything.
    const invocationStructure = React.useMemo(() => projectWorkflowInvocationStructure({
        definition: visibleDefinition,
        frozenChildren: visibleAcceptedContext?.frozenChildren,
        invocations: allInvocations,
        progressByInvocationId: visibleProgressByInvocationId,
    }), [allInvocations, visibleAcceptedContext?.frozenChildren, visibleDefinition, visibleProgressByInvocationId]);
    const selectedInvocation = selectedInvocationId === null
        ? null
        : allInvocations.find((entry) => entry.id === selectedInvocationId) ?? null;
    const selectedInvocationContentRevision = selectedInvocation?.contentRevision ?? null;
    const selectedEvidence = selectedInvocationId === null ? undefined : invocationEvidenceById.get(selectedInvocationId);
    const selectedContentUnavailable = selectedReadUnavailable || !contentBelongsToActiveScope
        || selectedInvocation === null || selectedEvidence === undefined
        || selectedEvidence.index.contentRevision !== selectedInvocation.contentRevision;
    const invocationCoverage = React.useMemo(() => summarizeWorkflowInvocationCoverage(allInvocations, {
        kindsByInvocationId: new Map([...invocationStructure].map(([id, entry]) => [id, entry.coverageKind])),
        historyComplete: invocationWindow?.loaded === true && invocationWindow.nextCursor == null,
        ...(summary === null ? {} : { runState: summary.state }),
        knownFailure: visibleFirstFailedInvocation !== null,
    }), [allInvocations, invocationStructure, invocationWindow?.loaded, invocationWindow?.nextCursor, summary?.state, visibleFirstFailedInvocation]);
    const changedRowCount = React.useMemo(() => allInvocations.reduce((count, invocation) => (
        previousLifecyclesRef.current.get(invocation.id) === invocation.lifecycle ? count : count + 1
    ), 0), [allInvocations]);
    React.useEffect(() => {
        previousLifecyclesRef.current = new Map(allInvocations.map((entry) => [entry.id, entry.lifecycle]));
    }, [allInvocations]);
    React.useEffect(() => {
        if (invocationWindow?.loaded) setAnnouncementsEnabled(true);
    }, [invocationWindow?.loaded]);
    const announcementProjection = React.useMemo(() => visibleDefinition === null ? null
        : projectWorkflowFlow(visibleDefinition, visibleAcceptedContext?.frozenChildren),
    [visibleAcceptedContext?.frozenChildren, visibleDefinition]);
    const announcementState = React.useMemo(() => ({
        blockIds: announcementProjection?.nodes.map((node) => node.nodeId) ?? [],
        selectedBlockId: selectedInvocationId === null
            ? null
            : invocationStructure.get(selectedInvocationId)?.nodeId ?? selectedInvocationId,
        blockingIssue: null,
        attentionCount: visibleAttentionInvocations.length,
        terminal: summary === null ? null : resolveAnnouncementTerminal(summary.state, invocationCoverage.knownFailure),
        changedRowCount,
        selectedRowChanged: selectedInvocationId !== null
            && previousLifecyclesRef.current.get(selectedInvocationId) !== allInvocations.find((entry) => entry.id === selectedInvocationId)?.lifecycle,
        // The same paging facts the visible content states: partial windows are
        // announced as loaded, never as exact totals of the whole Run.
        attentionHasMore: attentionNextCursor !== null,
        historyIncomplete: !(invocationWindow?.loaded === true && invocationWindow?.nextCursor == null),
    } as const), [allInvocations, announcementProjection, changedRowCount, invocationCoverage.knownFailure, invocationStructure, selectedInvocationId, summary, visibleAttentionInvocations.length, attentionNextCursor, invocationWindow?.loaded, invocationWindow?.nextCursor]);
    useWorkflowAnnouncements({
        state: announcementState,
        enabled: announcementsEnabled,
        resolveBlockLabel: (nodeId) => announcementProjection?.nodesById.get(nodeId)?.label ?? nodeId,
    });

    /**
     * Settle one exact invocation read through the existing Run index and
     * opened-progress owners. Only the latest issued read for this Account,
     * Run and selection publishes and confirms: a superseded or mismatched
     * response is ignored, so it can neither regress fresher content nor arm
     * a callback from evidence nobody confirmed. Callers fence Account/content
     * lifetime before using this; the response itself never becomes local
     * settlement. Returns whether the response confirmed the selection.
     */
    const settleExactInvocation = React.useCallback((
        token: PendingExactInvocationRead,
        response: ExactInvocationResponse,
    ): boolean => {
        if (exactInvocationRequestRef.current !== token) return false;
        if (!isContentIdentityCurrent(token.contentIdentity)) return false;
        const index = response.invocation?.index;
        if (index?.runId !== token.runId || index?.id !== token.invocationId) return false;
        if (response.invocation.parentRevision < token.revision) return false;
        if (token.contentRevision !== null && isWorkflowInvocationFactOlder(index, {
            id: token.invocationId, contentRevision: token.contentRevision,
        })) return false;
        const known = getStorage().getState().workflowRunInvocationsByRunId[token.runId]?.factsById[token.invocationId];
        if (known && isWorkflowInvocationFactOlder(index, known)) return false;
        // The selected row stays visible through history, while the store's
        // attention membership follows the fresh lifecycle: a settled row
        // leaves the filtered window so its approve/answer callbacks withdraw.
        getStorage().getState().upsertWorkflowRunInvocation({
            runId: token.runId,
            invocation: { ...response.invocation.index, opened: response.invocation },
            parentRevision: response.invocation.parentRevision,
        });
        setSelectedContentUnavailable(false);
        return true;
    }, [isContentIdentityCurrent]);

    React.useEffect(() => {
        if (!activelyViewed || runId === null || selectedInvocationId === null) return;
        const requestIdentity = contentIdentity;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        let cancelled = false;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const token: PendingExactInvocationRead = {
            contentIdentity: requestIdentity,
            runId,
            invocationId: selectedInvocationId,
            revision: summary?.revision ?? 0,
            contentRevision: selectedInvocationContentRevision,
        };
        exactInvocationRequestRef.current = token;
        // The last-known content stays rendered, but the evidence is
        // unconfirmed before this request answers: no permission or recovery
        // callback may act on it until the matching response confirms it.
        setSelectedContentUnavailable(true);
        void (async () => {
            try {
                const response = await workflowRunDetailActions.getInvocation(
                    { runId, invocationId: selectedInvocationId },
                    controller.signal,
                );
                if (cancelled || !lifetime.isCurrent()) return;
                settleExactInvocation(token, response);
            } catch {
                // The index remains useful when the exact Action read fails.
                if (!cancelled && lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)
                    && exactInvocationRequestRef.current === token) {
                    setSelectedContentUnavailable(true);
                }
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            retirement.dispose();
        };
    }, [accountScopeKey, activelyViewed, contentIdentity, invocationInvalidationToken, isContentIdentityCurrent, settleExactInvocation, runId, selectedInvocationId, selectedInvocationContentRevision, summary?.revision]);

    // One owner decides the haptic and its visible twin together, so a device
    // can never buzz for a completion the screen did not show.
    const completionEmphasis = useWorkflowCompletionMoment({
        state: summary?.state ?? null,
        identity: contentIdentity,
        observing: activelyViewed,
    });

    /**
     * Issue one durable operation against this exact Run under the mutex.
     *
     * `operation` receives the Run summary the operation is issued against, so
     * every caller sends the same `expectedRevision` the screen shows. The
     * returned Run lands in the shared row owner only while this token is still
     * the one in flight for this Account and Run; a settlement that lost that
     * race is dropped, and the authoritative state arrives through the
     * canonical read. `settle` runs in that same fenced window for the one
     * operation whose result is not a Run (deletion).
     */
    const issueRunOperation = React.useCallback(async <T,>(
        kind: WorkflowRunOperationKind,
        operation: (current: WorkflowRunSummaryV1) => Promise<T>,
        settle: (result: T) => void,
    ): Promise<void> => {
        if (!canEdit || runId === null || summary === null) return;
        if (pendingOperationRef.current !== null) return;
        const requestIdentity = contentIdentity;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        const token: PendingRunOperation = { kind, contentIdentity: requestIdentity };
        pendingOperationRef.current = token;
        setPendingOperation(token);
        setControlError(null);
        const owns = () => pendingOperationRef.current === token
            && lifetime.isCurrent()
            && isContentIdentityCurrent(requestIdentity);
        try {
            const result = await operation(summary);
            if (owns()) settle(result);
        } catch (error) {
            // The durable intent may still have been recorded; the authoritative
            // Run state arrives through the canonical read, never from this catch.
            // The canonical mapping decides the sentence AND whether it
            // interrupts; keeping only the sentence is what left a failed Stop
            // silent to a screen reader.
            if (owns()) setControlError(resolveWorkflowProblemPresentation(error));
        } finally {
            if (pendingOperationRef.current === token) {
                pendingOperationRef.current = null;
                if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) setPendingOperation(null);
            }
        }
    }, [canEdit, contentIdentity, isContentIdentityCurrent, runId, summary]);

    const settleRun = React.useCallback((result: Readonly<{ run: WorkflowRunSummaryV1 }>) => {
        getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(result.run)]);
    }, []);

    /**
     * Cancellation is the one control whose acceptance is not its application.
     *
     * Pause and resume move the returned Run's own state, so the shared row
     * says what happened. An accepted cancellation of an admitted Run keeps the
     * Run active and answers `intent: 'cancel_requested'`; the request receipt
     * therefore has to be kept, or the label reverts to **Stop** the instant the
     * transport settles. It is recorded separately from the transport mutex and
     * is superseded by the indexed `cancel_requested` rows the next read brings.
     */
    const settleControl = React.useCallback((result: Readonly<{
        run: WorkflowRunSummaryV1;
        intent: 'pause_requested' | 'paused' | 'resumed' | 'recovery_required' | 'unavailable' | 'cancel_requested' | 'cancelled';
    }>) => {
        if (result.intent === 'cancel_requested') setCancelRequestReceipt(true);
        settleRun(result);
    }, [settleRun]);

    const submitControl = React.useCallback(async (
        kind: 'pause' | 'resume' | 'cancel',
    ) => {
        if (runId === null) return;
        await issueRunOperation(kind, (current) => (kind === 'pause'
            ? workflowRunDetailActions.pauseRun({ runId, expectedRevision: current.revision })
            : kind === 'cancel'
                ? workflowRunDetailActions.cancelRun({ runId, expectedRevision: current.revision })
                : workflowRunDetailActions.resumeRun({
                    mode: 'boundary',
                    runId,
                    expectedRevision: current.revision,
                })), settleControl);
    }, [issueRunOperation, runId, settleControl]);

    const loadMoreInvocations = React.useCallback(async () => {
        if (runId === null || invocationWindow?.nextCursor == null || loadingMoreInvocations) return;
        const requestIdentity = contentIdentity;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        setLoadingMoreInvocations(true);
        try {
            const page = await workflowRunDetailActions.listInvocations({ runId, cursor: invocationWindow.nextCursor });
            if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
            getStorage().getState().applyWorkflowRunInvocationPage({
                runId, invocations: page.invocations, nextCursor: page.nextCursor ?? null,
                parentRevision: page.parentRevision, mode: 'append',
            });
            // Only the page that actually arrived clears the failure it replaces.
            setPagingFailure((current) => (current?.window === 'history' ? null : current));
        } catch {
            // The loaded rows and the cursor are untouched: only this page is
            // missing, and Retry asks for exactly it again.
            if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) {
                setPagingFailure({ contentIdentity: requestIdentity, window: 'history' });
            }
        } finally {
            if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) setLoadingMoreInvocations(false);
        }
    }, [contentIdentity, invocationWindow?.nextCursor, isContentIdentityCurrent, loadingMoreInvocations, runId]);

    const loadMoreAttention = React.useCallback(async () => {
        if (runId === null || attentionNextCursor === null) return;
        if (pendingAttentionPageRef.current !== null) return;
        const requestIdentity = contentIdentity;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        const token = {};
        pendingAttentionPageRef.current = token;
        setLoadingMoreAttention(true);
        try {
            const page = await workflowRunDetailActions.listInvocations({
                runId, cursor: attentionNextCursor, lifecycles: WORKFLOW_ATTENTION_LIFECYCLES,
            });
            if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
            getStorage().getState().applyWorkflowRunInvocationPage({
                runId, window: 'attention', invocations: page.invocations, nextCursor: page.nextCursor ?? null,
                parentRevision: page.parentRevision, mode: 'append',
            });
            attentionPageCountRef.current += 1;
            setPagingFailure((current) => (current?.window === 'attention' ? null : current));
        } catch {
            if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) {
                setPagingFailure({ contentIdentity: requestIdentity, window: 'attention' });
            }
        } finally {
            // Only the request that took the token releases it, so a settlement
            // that lost its Account or Run cannot free a newer one.
            if (pendingAttentionPageRef.current === token) {
                pendingAttentionPageRef.current = null;
                if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) setLoadingMoreAttention(false);
            }
        }
    }, [attentionNextCursor, contentIdentity, isContentIdentityCurrent, runId]);

    /**
     * The window whose continuation failed, once — and only once — the failure
     * still belongs to what is on screen.
     */
    const visiblePagingFailure = pagingFailure !== null && pagingFailure.contentIdentity === contentIdentity
        ? pagingFailure.window
        : null;

    const selectedProgress = selectedInvocationId === null
        ? null
        : visibleProgressByInvocationId.get(selectedInvocationId) ?? null;
    const settleReview = React.useCallback((run: WorkflowRunSummaryV1) => {
        getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)]);
        setInvocationInvalidationToken((token) => token + 1);
    }, []);
    const selectedExecutionRunId = selectedProgress?.execution?.kind === 'detached_run'
        ? selectedProgress.execution.runId
        : null;

    const retirePendingPermissionDecision = React.useCallback((decision: PendingPermissionDecision) => {
        const requestKey = permissionRequestKey(decision.executionRunId, decision.requestId);
        if (pendingPermissionDecisionsRef.current.get(requestKey) !== decision) return;
        const next = new Map(pendingPermissionDecisionsRef.current);
        next.delete(requestKey);
        pendingPermissionDecisionsRef.current = next;
        setPendingPermissionDecisions(next);
    }, []);

    React.useEffect(() => {
        if (selectedInvocationId === null || selectedProgress === null) return;
        for (const decision of pendingPermissionDecisionsRef.current.values()) {
            if (
                decision.accountLifetime.isCurrent()
                && decision.contentIdentity === contentIdentity
                && decision.runId === runId
                && decision.invocationId === selectedInvocationId
                && (
                    selectedExecutionRunId !== decision.executionRunId
                    || !hasWorkflowInvocationRequest(selectedProgress, decision.requestId)
                )
            ) {
                // Only the canonical opened invocation content can establish
                // that the request this screen answered has been withdrawn.
                retirePendingPermissionDecision(decision);
            }
        }
    }, [contentIdentity, pendingPermissionDecisions, retirePendingPermissionDecision, runId, selectedExecutionRunId, selectedInvocationId, selectedProgress]);

    /**
     * Answers one request for the selected detached Execution Run.
     *
     * The canonical prompt card that calls this owns the in-flight, answered
     * and failed presentation, so a failure is rejected back to it rather than
     * shown a second time here. The promise settles only after the exact
     * re-read, so the card's own in-flight state spans the whole exchange.
     */
    const respondToSelectedRequest = React.useCallback(async (request: ExecutionRunPromptResponse): Promise<void> => {
        if (
            activeAccountScope === null
            || summary === null
            || runId === null
            || selectedInvocationId === null
            || selectedExecutionRunId === null
            || !summary.machineId.trim()
        ) throw new Error(t('errors.operationFailed'));
        const requestKey = permissionRequestKey(selectedExecutionRunId, request.requestId);
        // The decision already in flight owns this request: the opposite press
        // must not send a competing answer the machine would settle second.
        if (pendingPermissionDecisionsRef.current.has(requestKey)) return;
        const requestIdentity = contentIdentity;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) throw new Error(t('errors.operationFailed'));
        const decision: PendingPermissionDecision = {
            accountLifetime: lifetime,
            contentIdentity: requestIdentity,
            runId,
            invocationId: selectedInvocationId,
            executionRunId: selectedExecutionRunId,
            requestId: request.requestId,
        };
        const pending = new Map(pendingPermissionDecisionsRef.current).set(requestKey, decision);
        pendingPermissionDecisionsRef.current = pending;
        setPendingPermissionDecisions(pending);
        setControlError(null);
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let transportIssued = false;
        let definitivePreIssuanceFailure = false;
        let responseFailure: Error | null = null;
        try {
            try {
                const response = await executeSourceAction('execution.run.permission.respond', {
                    runId: selectedExecutionRunId,
                    requestId: request.requestId,
                    ...('answers' in request ? { answers: request.answers } : { approved: request.approved }),
                }, {
                    surface: 'ui',
                    serverId: activeAccountScope.serverId,
                    expectedAccountId: activeAccountScope.accountId,
                    executionRunTargetMachineId: summary.machineId,
                    signal: controller.signal,
                    onTransportIssued: () => {
                        transportIssued = true;
                    },
                });
                if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
                // An Action may queue its own approval without reaching the
                // detached writer. There is no uncertain answer to withdraw.
                if (response.ok && !transportIssued) retirePendingPermissionDecision(decision);
                if (!response.ok) {
                    definitivePreIssuanceFailure = !transportIssued || isDefinitivePermissionDecisionPreIssuanceResponse(response);
                    responseFailure = new Error(t('errors.operationFailed'));
                }
            } catch (error) {
                // The daemon may still have recorded the answer; an unreachable
                // machine only means this screen cannot say that it did.
                if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
                definitivePreIssuanceFailure = !transportIssued;
                responseFailure = new Error(resolveWorkflowProblemPresentation(error).message);
            }

            if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
            try {
                // The reconcile re-read joins the same single flight the
                // selection effect owns: it supersedes an older in-flight
                // read, and a newer one supersedes it. Only its matching
                // answer publishes and confirms.
                const reconcileToken: PendingExactInvocationRead = {
                    contentIdentity: requestIdentity,
                    runId,
                    invocationId: selectedInvocationId,
                    revision: summary?.revision ?? 0,
                    contentRevision: selectedInvocationContentRevision,
                };
                exactInvocationRequestRef.current = reconcileToken;
                const exact = await workflowRunDetailActions.getInvocation({
                    runId,
                    invocationId: selectedInvocationId,
                }, controller.signal);
                if (!lifetime.isCurrent() || !isContentIdentityCurrent(requestIdentity)) return;
                const confirmed = settleExactInvocation(reconcileToken, exact);
                // Rejected exact content cannot prove that an issued request
                // settled. Only accepted current evidence may retire it.
                const requestSettled = confirmed && !(exact.invocation.progress.execution?.kind === 'detached_run'
                    && exact.invocation.progress.execution.runId === selectedExecutionRunId
                    && hasWorkflowInvocationRequest(exact.invocation.progress, request.requestId));
                if (requestSettled || definitivePreIssuanceFailure) {
                    retirePendingPermissionDecision(decision);
                }
            } catch (error) {
                // Without current exact content the outcome remains unknown.
                // Keep controls withdrawn; a later canonical read retires them.
                if (lifetime.isCurrent() && isContentIdentityCurrent(requestIdentity)) {
                    setControlError(resolveWorkflowProblemPresentation(error));
                }
            }
            if (responseFailure !== null) throw responseFailure;
        } finally {
            retirement.dispose();
        }
    }, [activeAccountScope, contentIdentity, executeSourceAction, isContentIdentityCurrent, settleExactInvocation, retirePendingPermissionDecision, runId, selectedExecutionRunId, selectedInvocationId, selectedInvocationContentRevision, summary]);
    /**
     * The withdrawn controls for the attempt currently on screen. A decision
     * belonging to another execution Run is not shown here, so its key cannot
     * disable a same-named request on this one.
     */
    const pendingRequestIds = React.useMemo(() => {
        if (selectedExecutionRunId === null || selectedInvocationId === null || pendingPermissionDecisions.size === 0) {
            return EMPTY_PERMISSION_REQUEST_IDS;
        }
        const requestIds = new Set<string>();
        for (const decision of pendingPermissionDecisions.values()) {
            if (
                decision.accountLifetime.isCurrent()
                && decision.contentIdentity === contentIdentity
                && decision.runId === runId
                && decision.invocationId === selectedInvocationId
                && decision.executionRunId === selectedExecutionRunId
            ) {
                requestIds.add(decision.requestId);
            }
        }
        return requestIds;
    }, [contentIdentity, pendingPermissionDecisions, runId, selectedExecutionRunId, selectedInvocationId]);
    const uncertaintyAcknowledgementRequired = requiresUncertainPriorEffectsAcknowledgement({
        invocation: selectedInvocation,
        progress: selectedProgress,
    });
    /**
     * The one recovery eligibility answer this screen acts on.
     *
     * `WorkflowRunContent` renders its cards from the same projection, so the
     * control that is drawn and the handler it can reach are decided once.
     * While this screen re-derived restoration from a looser condition of its
     * own, D4's two arms could be live together — restore this Run, or start a
     * reviewed new one that repeats its completed work.
     */
    const selectedRecovery = React.useMemo(() => (
        summary === null ? null : projectWorkflowInvocationRecovery({
            run: summary,
            invocation: selectedInvocation,
            progress: selectedProgress,
            recoveryAvailability: selectedInvocationId === null
                ? null
                : recoveryAvailabilityByInvocationId.get(selectedInvocationId) ?? null,
            machineHomeDirectory: runMachine?.metadata?.homeDir ?? null,
            invocations: allInvocations,
            invocationHistoryComplete: (invocationWindow?.loaded ?? false) && invocationWindow?.nextCursor == null,
        })
    ), [allInvocations, invocationWindow, recoveryAvailabilityByInvocationId, runMachine, selectedInvocation, selectedInvocationId, selectedProgress, summary]);
    // Acknowledgement is recorded against the exact attempt it was given for.
    // Changing selection therefore withdraws it rather than carrying blanket
    // consent to a different invocation.
    const uncertaintyAcknowledged = acknowledgedUncertainInvocation !== null
        && acknowledgedUncertainInvocation.recordId === selectedInvocationId
        && acknowledgedUncertainInvocation.contentRevision === selectedInvocationContentRevision;
    const acknowledgeUncertainPriorEffects = React.useCallback(() => {
        if (selectedInvocationId === null || selectedInvocationContentRevision === null) return;
        setAcknowledgedUncertainInvocation((current) => (
            current?.recordId === selectedInvocationId && current.contentRevision === selectedInvocationContentRevision
                ? null : { recordId: selectedInvocationId, contentRevision: selectedInvocationContentRevision }
        ));
    }, [selectedInvocationContentRevision, selectedInvocationId]);

    const retrySelected = React.useCallback(async (
        conversation: 'same_conversation' | 'fresh_agent',
        replacement?: WorkflowAuthoredInputV1,
    ) => {
        if (runId === null || selectedInvocationId === null || !selectedRecovery
            || selectedRecovery.retryCausalInvocationIds.length === 0) return;
        // An attempt whose prior effects are unknown is not retried until this
        // exact attempt has been acknowledged. The Action owner revalidates.
        if (uncertaintyAcknowledgementRequired && !uncertaintyAcknowledged) return;
        await issueRunOperation('retry', (current) => workflowRunDetailActions.retryInvocation({
            runId,
            expectedRevision: current.revision,
            invocation: { recordId: selectedInvocationId },
            causalInvocationIds: [...selectedRecovery.retryCausalInvocationIds],
            conversation,
            input: replacement === undefined
                ? { kind: 'original' }
                : { kind: 'replacement', value: replacement },
            ...(uncertaintyAcknowledgementRequired ? { acknowledgeUncertainPriorEffects: true as const } : {}),
        }), settleRun);
    }, [issueRunOperation, runId, selectedInvocationId, selectedRecovery, settleRun, uncertaintyAcknowledged, uncertaintyAcknowledgementRequired]);

    /**
     * Accepts the continuation the execution owner prepared for this exact
     * invocation. It records a new attempt on the same logical invocation and
     * preserves the previous one; it never repeats completed predecessors.
     */
    const continuePrepared = React.useCallback(async (choice: WorkflowRecoveryContinuation) => {
        // The canonical continuation input is required and non-empty.
        if (choice.document.text.trim().length === 0) return;
        await retrySelected(choice.conversation, { document: choice.document, input: choice.input });
    }, [retrySelected]);

    const restoreSelectedWorkspace = React.useCallback(async () => {
        if (runId === null || selectedInvocationId === null) return;
        await issueRunOperation('restore_workspace', (current) => workflowRunDetailActions.restoreWorkspace({
            mode: 'recover', runId, expectedRevision: current.revision,
            invocations: [{
                kind: 'restore_workspace',
                invocation: { recordId: selectedInvocationId },
                conversation: selectedProgress?.recovery?.conversation ?? 'fresh_agent',
                input: selectedProgress?.recovery?.input ?? { kind: 'original' },
            }],
        }, current.machineId), settleRun);
    }, [issueRunOperation, runId, selectedInvocationId, selectedProgress, settleRun]);

    const reattachSelected = React.useCallback(async () => {
        if (runId === null || selectedInvocationId === null) return;
        await issueRunOperation('reattach', (current) => workflowRunDetailActions.resumeRun({
            mode: 'recover', runId, expectedRevision: current.revision,
            invocations: [{ kind: 'reattach', invocation: { recordId: selectedInvocationId } }],
        }), settleRun);
    }, [issueRunOperation, runId, selectedInvocationId, settleRun]);

    const deleteRun = React.useCallback(async () => {
        if (runId === null || summary === null) return;
        const requestIdentity = contentIdentity;
        const confirmed = await Modal.confirm(
            t('workflows.run.deleteHistory'), t('workflows.run.deleteHistoryConfirm'),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed || !isContentIdentityCurrent(requestIdentity)) return;
        await issueRunOperation(
            'delete',
            (current) => workflowRunDetailActions.deleteRun({ runId, expectedRevision: current.revision }),
            () => {
                getStorage().getState().removeWorkflowRun(runId);
                router.back();
            },
        );
    }, [contentIdentity, isContentIdentityCurrent, issueRunOperation, router, runId, summary]);

    const admitRunAgain = React.useCallback(async (inputs: Readonly<Record<string, JsonValue>> | undefined) => {
        if (visibleDefinition === null || visibleAcceptedContext === null || summary === null) return;
        if (runAgainAgentOverride !== null && runAgainAgentOverride.engine === undefined) return;
        const requestIdentity = contentIdentity;
        const nextRunId = pendingRunAgainIdRef.current ?? randomUUID();
        pendingRunAgainIdRef.current = nextRunId;
        const repeatDefinition = buildWorkflowReviewedRunSeed({ run: summary, definition: visibleDefinition,
            acceptedContext: visibleAcceptedContext }).definition;
        const admitted = await runNow.runNow({
            runId: nextRunId,
            ...(visibleAcceptedContext.metadata ? { metadata: visibleAcceptedContext.metadata } : {}),
            source: {
                kind: 'inline',
                definition: { ...repeatDefinition, inputs: [...repeatDefinition.inputs], blocks: [...repeatDefinition.blocks] },
                replay: { runId: summary.id, ...(runAgainAgentOverride?.engine ? { agentOverride: {
                    sourceKey: runAgainAgentOverride.sourceKey, blockId: runAgainAgentOverride.blockId,
                    engine: runAgainAgentOverride.engine,
                } } : {}) },
            },
            // "Run again" repeats this Run. Its accepted runtime is part of what
            // it was: dropping it would silently repeat effectful work under
            // different execution, approval and lifecycle semantics.
            executionTarget: visibleAcceptedContext.executionTarget,
            ...(visibleAcceptedContext.roleOverrides === undefined ? {} : { roleOverrides: [...visibleAcceptedContext.roleOverrides] }),
            ...('origin' in visibleAcceptedContext && visibleAcceptedContext.origin.originSessionId
                ? { originSessionId: visibleAcceptedContext.origin.originSessionId } : {}),
            project: projectAcceptedWorkflowRunTarget(visibleAcceptedContext.workspaceTarget.project),
            ...(inputs === undefined ? {} : { inputs }),
        });
        if (admitted === null || !isContentIdentityCurrent(requestIdentity)) return;
        pendingRunAgainIdRef.current = null;
        setRunAgainInputOpen(false);
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: admitted.run.id } } as never);
    }, [contentIdentity, isContentIdentityCurrent, router, runNow, runAgainAgentOverride, summary, visibleAcceptedContext, visibleDefinition]);

    const requestRunAgain = React.useCallback(async () => {
        if (visibleDefinition === null || visibleAcceptedContext === null) return;
        setRunAgainValues(visibleAcceptedContext.inputs);
        setRunAgainRawTextValues({});
        setRunAgainAgentOverride(null);
        setRunAgainInputOpen(true);
    }, [visibleAcceptedContext, visibleDefinition]);

    const requestRunWithAnotherAgent = React.useCallback(() => {
        if (!selectedRecovery?.canRunWithAnotherAgent || !selectedProgress || !visibleAcceptedContext || !visibleDefinition) return;
        let definition = visibleDefinition;
        let sourceKey: WorkflowReplayAgentOverrideV1['sourceKey'] = '$root';
        for (const scope of selectedProgress.invocationPath.scope) {
            if (scope.kind !== 'workflow') continue;
            const owner = walkWorkflowBlocks(definition.blocks).find((candidate) => candidate.id === scope.blockId);
            if (owner?.kind !== 'workflow') return;
            const child = visibleAcceptedContext.frozenChildren[owner.workflowRef];
            if (!child) return;
            definition = child;
            sourceKey = owner.workflowRef;
        }
        const blockId = selectedProgress.invocationPath.blockId;
        const leaf = visibleAcceptedContext.materializedLeaves.find((candidate) => candidate.sourceKey === sourceKey
            && candidate.blockId === blockId && candidate.kind === 'step');
        if (!leaf) return;
        const block = walkWorkflowBlocks(definition.blocks).find((candidate) => candidate.id === blockId);
        if (block?.kind !== 'step') return;
        setRunAgainValues(visibleAcceptedContext.inputs);
        setRunAgainRawTextValues({});
        setRunAgainAgentOverride({ sourceKey, blockId, step: workflowBlockReferenceLabel(block) });
        setRunAgainInputOpen(true);
    }, [selectedProgress, selectedRecovery, visibleAcceptedContext, visibleDefinition]);

    /**
     * D4's second arm: when the recorded workspace cannot be used and no
     * restoration producer exists, the only truthful offer is opening the
     * accepted definition as a **new** Run the person reviews and starts. This
     * admits nothing — it hands the editor a reviewed copy — and the original
     * Run keeps its own history, results and identity.
     */
    const startReviewedNewRun = React.useCallback(() => {
        if (summary === null || visibleDefinition === null || visibleAcceptedContext === null) return;
        const reasonCode = selectedProgress?.reason?.code;
        if (!isWorkflowWorkspaceUnavailableReason(reasonCode)) return;
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: summary,
            definition: visibleDefinition,
            acceptedContext: visibleAcceptedContext,
            reasonCode,
        }));
        router.push({ pathname: '/workflows/new', params: { reviewedRunSeedId: seedId } } as never);
    }, [router, selectedProgress, summary, visibleAcceptedContext, visibleDefinition]);

    const copyWorkspace = React.useCallback(async (directory: string) => {
        const requestIdentity = contentIdentity;
        const copied = await setClipboardStringSafe(directory);
        if (!isContentIdentityCurrent(requestIdentity)) return;
        Modal.alert(
            copied ? t('common.copied') : t('common.error'),
            copied
                ? t('items.copiedToClipboard', { label: t('common.path') })
                : t('items.failedToCopyToClipboard'),
        );
    }, [contentIdentity, isContentIdentityCurrent]);

    const openWorkspace = React.useCallback((workspaceRefId: string, directory: string) => {
        const opened = openProject(workspaceRefId, { activeRootPath: directory });
        if (!opened) {
            setControlError({
                code: null,
                title: t('workflows.workspace.title'),
                message: t('workflows.workspace.unavailableBody'),
                repair: 'none',
                repairLabel: null,
                accessibilitySemantics: 'alert',
            });
        }
    }, [openProject]);

    const saveAsWorkflow = React.useCallback(() => {
        if (summary === null || visibleDefinition === null || visibleAcceptedContext === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || !lifetime.isCurrent() || !isContentIdentityCurrent(contentIdentity)) return;
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: summary,
            definition: visibleDefinition,
            acceptedContext: visibleAcceptedContext,
        }));
        router.push({ pathname: '/workflows/new', params: { reviewedRunSeedId: seedId } } as never);
    }, [contentIdentity, isContentIdentityCurrent, router, summary, visibleAcceptedContext, visibleDefinition]);

    /**
     * A mutating control only exists while the private evidence it acts on is
     * the evidence the current exact read validated.
     *
     * When that read fails the last-known progress stays inspectable and says
     * so, but approving a request or continuing an attempt from superseded
     * content is a decision nobody can stand behind: the request may already be
     * resolved or replaced. Deciding it once here keeps every control honest
     * without a guard bolted onto each button.
     */
    const selectedEvidenceConfirmed = !selectedContentUnavailable;
    const reviewCurrent = React.useCallback(() => activelyViewed && isContentIdentityCurrent(contentIdentity),
        [activelyViewed, contentIdentity, isContentIdentityCurrent]);
    const whenEvidenceConfirmed = React.useCallback(
        <T,>(callback: T | undefined): T | undefined => (canEdit && selectedEvidenceConfirmed ? callback : undefined),
        [canEdit, selectedEvidenceConfirmed],
    );

    /**
     * The durable stop receipt, from the canonical owner rather than from the
     * request's own lifetime. A terminal Run has already applied it, so the
     * receipt retires with the state it was waiting for.
     */
    const cancelRequested = summary !== null
        && !isTerminalWorkflowRunState(summary.state)
        && (cancelRequestReceipt || allInvocations.some((entry) => entry.lifecycle === 'cancel_requested'));

    /**
     * The one problem the outcome region reports, keeping the canonical
     * presentation rather than flattening it to a sentence.
     */
    const visibleProblem: WorkflowProblemPresentation | null = controlError
        ?? (loadState === 'failed'
            ? {
                code: null,
                title: t('workflows.loadFailedTitle'),
                message: t('workflows.loadFailedBody'),
                repair: 'retry',
                repairLabel: t('common.retry'),
                accessibilitySemantics: 'alert',
            }
            : null);

    const runAgainModalProps = React.useMemo<WorkflowRunComposerModalProps | null>(
        () => visibleDefinition === null ? null : ({
            definition: visibleDefinition,
            materializedLeaves: visibleAcceptedContext?.materializedLeaves,
            roleOverrides: visibleAcceptedContext?.roleOverrides,
            inputs: visibleDefinition.inputs,
            ...(sourceRef ? { optionsConsumer: { kind: 'workflow' as const, workflow: sourceRef } } : {}),
            values: runAgainValues,
            onChangeValues: setRunAgainValues,
            rawTextValues: runAgainRawTextValues,
            onChangeRawTextValues: setRunAgainRawTextValues,
            workflowName: visibleAcceptedContext?.metadata?.title,
            notice: t('workflows.recovery.repeatedEffectWarning'),
            startDisabled: runAgainAgentOverride !== null && runAgainAgentOverride.engine === undefined,
            preview: visibleAcceptedContext?.metadata?.description || visibleDefinition.blocks.map(workflowBlockReferenceLabel).join('\n'),
            machineId: visibleAcceptedContext?.machineId ?? null,
            ...(visibleAcceptedContext === null ? {} : { extraActionChips: [{
                ...createExecutionRunStartContentChip({
                    key: 'workflow-start-where', icon: 'folder', title: t('workflows.page.where.label'),
                    label: formatWorkflowWhereSummary({ target: visibleAcceptedContext.workspaceTarget.project,
                        machineName: getMachineDisplayName(runMachine) }) ?? visibleAcceptedContext.machineId,
                    testID: 'workflow-start-where-chip',
                    // No setter: this is the accepted target, not another authored choice.
                    renderContent: <WorkflowProjectTargetControl target={visibleAcceptedContext.workspaceTarget.project}
                        machineName={getMachineDisplayName(runMachine)} testIDPrefix="workflow-repeat-where" />,
                }), controlId: 'machine' as const,
            }, ...(runAgainAgentOverride === null ? [] : [{ ...createExecutionRunStartContentChip({
                key: 'workflow-run-another-agent', icon: 'users', title: t('workflows.start.agentForStep', { step: runAgainAgentOverride.step }),
                label: t('workflows.start.agentForStep', { step: runAgainAgentOverride.step }),
                testID: 'workflow-run-another-agent-chip',
                revision: JSON.stringify(runAgainAgentOverride.engine),
                disabled: runNow.stateFor(pendingRunAgainIdRef.current ?? '') === 'submitting',
                renderContent: <WorkflowRunAgentOverrideField step={runAgainAgentOverride.step} value={runAgainAgentOverride.engine}
                    disabled={runNow.stateFor(pendingRunAgainIdRef.current ?? '') === 'submitting'}
                    onChange={(engine) => setRunAgainAgentOverride((current) => current === null ? null : { ...current, engine })} />,
            }), controlId: 'engine' as const }])] }),
            onRun: (inputs) => { void admitRunAgain(inputs); },
            onCancel: () => setRunAgainInputOpen(false),
            pending: runNow.stateFor(pendingRunAgainIdRef.current ?? '') === 'submitting',
        }),
        [admitRunAgain, runAgainAgentOverride, runAgainRawTextValues, runAgainValues, runMachine, runNow, sourceRef, visibleAcceptedContext, visibleDefinition],
    );

    useWorkflowRunComposerModal({
        open: runAgainInputOpen,
        props: runAgainModalProps,
        testID: 'workflow-run-again-inputs-modal',
    });

    if (runId === null) {
        return (
            <View style={[styles.root, styles.centered]}>
                <SurfaceStateCard
                    testID="workflow-run-unavailable"
                    kind="unavailable"
                    title={t('workflows.loadFailedTitle')}
                    reason={t('workflows.loadFailedBody')}
                />
            </View>
        );
    }

    if (summary === null) {
        return (
            <View testID="workflow-run-screen" style={[styles.root, styles.centered]}>
                {loadState === 'failed' ? (
                    <SurfaceStateCard
                        testID="workflow-run-load-failed"
                        kind="error"
                        title={t('workflows.loadFailedTitle')}
                        reason={t('workflows.loadFailedBody')}
                        action={{ label: t('common.retry'), onPress: retryLoad }}
                        accessibilitySemantics="alert"
                    />
                ) : (
                    <SurfaceStateCard testID="workflow-run-loading" kind="loading" title={t('common.loading')} />
                )}
            </View>
        );
    }

    return (
        <View
            testID="workflow-run-screen"
            style={styles.root}
        >
            <WorkflowRunContent
                notificationOperation={activeAccountScope !== null && visibleAcceptedContext !== null
                    && !isTerminalWorkflowRunState(summary.state) ? <RunWorkNotifications
                        source={{ kind: 'workflow_run', runId: summary.id }}
                        project={projectAcceptedWorkflowRunTarget(visibleAcceptedContext.workspaceTarget.project)}
                        serverId={activeAccountScope.serverId} /> : undefined}
                run={summary}
                machineName={getMachineDisplayName(runMachine)}
                {...(runMachine === null || runMachine === undefined
                    ? {}
                    : { machineReachable: isMachineOnline(runMachine) })}
                // An opened accepted context with no metadata is an untitled
                // Run — the unnamed-draft case — not private content this
                // device cannot open; only an unopened context is unavailable.
                title={visibleAcceptedContext === null
                    ? null
                    : formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(
                        visibleAcceptedContext.metadata === undefined
                            ? null
                            : { kind: 'available', value: visibleAcceptedContext.metadata },
                    ))}
                definition={visibleDefinition}
                frozenChildren={visibleAcceptedContext?.frozenChildren}
                materializedLeaves={visibleAcceptedContext?.materializedLeaves}
                hasSource={hasSource}
                sourceAction={sourceAction}
                invocations={allInvocations}
                invocationsLoaded={invocationWindow?.loaded ?? false}
                invocationHistoryComplete={(invocationWindow?.loaded ?? false) && invocationWindow?.nextCursor == null}
                selectedInvocationId={selectedInvocationId}
                onSelectInvocation={(invocationId) => {
                    setSelectedInvocationId(invocationId);
                    if (!detailsPaneAvailable && requestedInvocationId === null) router.push(createWorkflowInvocationRoute(runId, invocationId) as never);
                }}
                onDeselectInvocation={() => {
                    if (!detailsPaneAvailable && requestedInvocationId !== null) router.back();
                    else setSelectedInvocationId(null);
                }}
                active={activelyViewed}
                serverId={activeAccountScope?.serverId ?? null}
                invocationPage={requestedInvocationId !== null}
                renderReviewCard={selectedInvocation && selectedProgress && visibleAcceptedContext && selectedInvocationContentRevision !== null
                    && (selectedInvocation.lifecycle === 'waiting_for_review'
                        || (selectedInvocation.lifecycle === 'completed' && selectedProgress.blockKind !== 'wait'
                            && WorkflowResultContractSchema.safeParse(selectedProgress.resultContract).data?.kind === 'json'
                            && selectedProgress.result !== undefined && readWorkflowPlanResult(selectedProgress.result) !== null))
                    ? (onDiscuss, placement) => <WorkflowInvocationReview key={`${contentIdentity}:${selectedInvocation.id}`}
                        run={summary} callerAccess={{ canEdit }} acceptedContext={visibleAcceptedContext} invocation={selectedInvocation}
                        progress={selectedProgress} contentRevision={selectedInvocationContentRevision} buffers={reviewBuffers}
                        active={activelyViewed} confirmed={selectedEvidenceConfirmed} compact={placement?.compact === true}
                        viewerAccountId={activeAccountScope?.accountId ?? null}
                        current={reviewCurrent} onSettled={settleReview}
                        onDiscuss={onDiscuss} machineName={getMachineDisplayName(runMachine)}
                        acknowledgeUncertainPriorEffects={uncertaintyAcknowledged ? acknowledgedUncertainInvocation ?? undefined : undefined}
                        machineReachable={runMachine ? isMachineOnline(runMachine) : undefined}
                        onOpenDraft={(seed) => router.push({ pathname: '/workflows/new', params: { reviewedRunSeedId: storeWorkflowReviewedRunSeed(seed) } } as never)}
                        onOpenRun={(id) => router.push(createWorkflowRunRoute(id) as never)} />
                    : undefined}
                view={view}
                onChangeView={setView}
                pendingControl={pendingOperation?.kind ?? null}
                onPause={canEdit ? () => { void submitControl('pause'); } : undefined}
                onResume={canEdit ? () => { void submitControl('resume'); } : undefined}
                onCancel={canEdit ? () => { void submitControl('cancel'); } : undefined}
                usageLabel={visibleUsageLabel}
                resultLabel={visibleResultLabel}
                finalOutputInvocationId={visibleFinalOutputInvocationId}
                firstFailedInvocationId={visibleFirstFailedInvocation?.id ?? null}
                firstFailedInvocationResolution={firstFailedInvocationResolution}
                selectedInvocationProgress={selectedProgress}
                selectedInvocationRecoveryAvailability={selectedInvocationId === null
                    ? null
                    : recoveryAvailabilityByInvocationId.get(selectedInvocationId) ?? null}
                invocationProgressById={visibleProgressByInvocationId}
                invocationStructure={invocationStructure}
                onOpenSession={activeAccountScope === null ? undefined : (sessionId) => router.push(
                    buildScopedSessionRouteHref({ sessionId, serverId: activeAccountScope.serverId }) as never,
                )}
                onOpenExecutionRun={activeAccountScope === null || !summary.machineId.trim() ? undefined : (executionRunId) => {
                    const route = createMachineExecutionRunRoute(
                        activeAccountScope.serverId,
                        summary.machineId,
                        executionRunId,
                    );
                    if (route !== null) router.push(route as never);
                }}
                // Native permission answers have their own Session/execution
                // authority; Run edit access only controls mutations of this Run.
                onRespondToRequest={selectedEvidenceConfirmed && selectedExecutionRunId !== null
                    ? respondToSelectedRequest
                    : undefined}
                pendingRequestIds={pendingRequestIds}
                workspaceHomeDirectory={runMachine?.metadata?.homeDir ?? null}
                onCopyWorkspace={(directory) => { void copyWorkspace(directory); }}
                onOpenWorkspace={openWorkspace}
                onLoadMoreInvocations={invocationWindow?.nextCursor == null ? undefined : () => { void loadMoreInvocations(); }}
                loadingMoreInvocations={loadingMoreInvocations}
                loadMoreInvocationsFailed={visiblePagingFailure === 'history'}
                onLoadMoreAttention={attentionNextCursor === null ? undefined : () => { void loadMoreAttention(); }}
                loadingMoreAttention={loadingMoreAttention}
                loadMoreAttentionFailed={visiblePagingFailure === 'attention'}
                attentionHasMore={attentionNextCursor !== null}
                onRetrySameConversation={whenEvidenceConfirmed(selectedInvocationId && selectedRecovery?.canRetrySameConversation ? () => { void retrySelected('same_conversation'); } : undefined)}
                onRetryFreshAgent={whenEvidenceConfirmed(selectedInvocationId && selectedRecovery?.canRetryFreshAgent ? () => { void retrySelected('fresh_agent'); } : undefined)}
                onRunWithAnotherAgent={whenEvidenceConfirmed(selectedRecovery?.canRunWithAnotherAgent
                    && visibleAcceptedContext !== null
                    ? requestRunWithAnotherAgent : undefined)}
                onRetryWithReplacement={whenEvidenceConfirmed(selectedInvocationId
                    && (selectedRecovery?.canRetrySameConversation || selectedRecovery?.canRetryFreshAgent)
                    ? (input) => { void retrySelected(input.conversation, { document: input.document, input: input.input }); }
                    : undefined)}
                preparedRecovery={selectedProgress?.recovery ?? null}
                onContinuePrepared={whenEvidenceConfirmed(selectedInvocationId !== null && selectedProgress?.recovery !== undefined
                    ? (choice) => { void continuePrepared(choice); }
                    : undefined)}
                uncertaintyAcknowledged={uncertaintyAcknowledged}
                onAcknowledgeUncertainPriorEffects={whenEvidenceConfirmed(uncertaintyAcknowledgementRequired
                    ? acknowledgeUncertainPriorEffects
                    : undefined)}
                onReattach={whenEvidenceConfirmed(selectedInvocationId !== null && selectedRecovery?.canReattach === true
                    ? () => { void reattachSelected(); }
                    : undefined)}
                onDelete={canEdit && isTerminalWorkflowRunState(summary.state) && summary.workflowCustodyState === 'settled' ? () => { void deleteRun(); } : undefined}
                deleteBlockedByCustody={isTerminalWorkflowRunState(summary.state) && summary.workflowCustodyState === 'pending'}
                onRunAgain={canEdit && visibleAcceptedContext !== null && isTerminalWorkflowRunState(summary.state)
                    ? () => { void requestRunAgain(); }
                    : undefined}
                onSaveAsWorkflow={visibleDefinition === null
                    || visibleAcceptedContext === null
                    ? undefined
                    : () => { void saveAsWorkflow(); }}
                saveAsWorkflowPending={false}
                onStartReviewedNewRun={whenEvidenceConfirmed(visibleAcceptedContext !== null
                    && selectedInvocationId !== null
                    && selectedRecovery?.canStartReviewedNewRun === true
                    ? startReviewedNewRun
                    : undefined)}
                onRestoreWorkspace={whenEvidenceConfirmed(selectedInvocationId !== null
                    && selectedRecovery?.canRestoreWorkspace === true
                    ? () => { void restoreSelectedWorkspace(); }
                    : undefined)}
                completionEmphasis={completionEmphasis}
                cancelRequested={cancelRequested}
                errorLabel={visibleProblem?.message ?? null}
                errorSemantics={visibleProblem?.accessibilitySemantics ?? 'alert'}
                onReload={loadState === 'failed' ? retryLoad : undefined}
                selectedContentUnavailable={selectedContentUnavailable}
                contentContainerStyle={contentStyle}
            />
        </View>
    );
}
