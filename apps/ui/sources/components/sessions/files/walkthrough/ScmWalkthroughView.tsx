import * as React from 'react';
import { View } from 'react-native';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveExecutionRunAgentMarkId, resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { useRunAnsweringEngine } from '@/components/sessions/runs/useRunAnsweringEngine';
import { selectScmDiffSummaryProducerModel } from '@/sync/domains/scm/diffSummary/state';
import { getPreferredLanguage, t } from '@/text';
import { RunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { resolveScmDiffSummaryDiscussionTarget, selectScmDiffSummaryDiscussionReply } from '@/sync/domains/scm/diffSummary/discussion';
import { useAskSessionReveal } from '@/components/ui/code/selection/useAskSessionReveal';
import { getSessionComposerDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
import { ScmDiffSummaryStartOptions, scmDiffSummaryPrerequisiteOf, scmDiffSummaryStartOptionsOf, useOpenExplainChangesSetting, useSummaryModelChoice } from '@/components/sessions/files/comparison/ScmDiffSummaryStartOptions';
import { applySavedScmDiffSummaryResult } from '@/sync/ops/scmDiffSummary/generate';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import type { useScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useScmDiffSummaryBinding';
import { WalkthroughView, type WalkthroughViewLayout } from './WalkthroughView';
import { WalkthroughStopExchangesProvider, type WalkthroughStopExchangesSource } from './WalkthroughStopExchanges';
import { EMPTY_WALKTHROUGH_READING, type WalkthroughPhase, type WalkthroughStop } from './walkthroughReading';
import { useWalkthroughReading } from './useWalkthroughReading';
import { useCapturedComparisonEvidence } from '../comparison/useCapturedComparisonEvidence';
import { useScmReviewedMarks } from '../comparison/useScmReviewedMarks';
import { useWalkthroughSavedActions } from './WalkthroughSavedActions';
import type { ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';
import { useWalkthroughReview } from '@/components/sessions/reviews/walkthrough/useWalkthroughReview';
import { ReviewExplainFindingsButton, useSessionWalkthroughReviewPresentation } from '@/components/sessions/reviews/walkthrough/SessionWalkthroughReview';
import { ReviewWalkthroughSteps } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { requestExplainReviewFindings } from '@/sync/ops/reviews/reviewWalkthrough';
import { ChangedFilesReviewFindButton } from '@/components/workspaces/scm/review/ChangedFilesReviewFind';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';

export type ScmWalkthroughViewProps = Readonly<{
    sessionId?: string;
    bound: ReturnType<typeof useScmDiffSummaryBinding>;
    displayMachineId: string | null;
    onAskStop?: (stop: WalkthroughStop, question?: string) => void;
    serverId?: string | null;
    comparison: SessionScmReviewComparison | null;
    scopeLabel: string;
    scopeDetail?: string | null;
    layout: WalkthroughViewLayout;
    active?: boolean;
    /** The comparison bar, drawn by the review destination above every view, with this view's own actions and menu rows. */
    renderBar: (actions: React.ReactNode, sections?: readonly ScmComparisonMenuSection[], review?: React.ReactNode) => React.ReactNode;
    onShowFiles: () => void;
    onOpenFile: (path: string) => void;
    /** Hands the person to the Session composer, whose recipient now names the generator. */
    onOpenComposer?: () => void;
    /** Reviewer Runs a Start review from this comparison launched, before the saved result names them. */
    startedReviewRunIds?: readonly string[] | null;
    /** Start review again with these engines selected (a partial review's failed reviewer). */
    onRetryReviewEngines?: (engineIds: readonly string[]) => void;
    /** Hosted by a page that heads the comparison and states its review (a Review): no header of its own. */
    hosted?: boolean;
}>;

/**
 * The Walkthrough view bound to an admitted host: the comparison's walkthrough analysis from the one diff-summary
 * store, the person's marks from Account KV, and Discuss through the generating run's real affordances.
 */
export const ScmWalkthroughView = React.memo(function ScmWalkthroughView(props: ScmWalkthroughViewProps) {
    // The comparison's saved result, restore/reread and START: the one binding Walkthrough and Commits share.
    const bound = props.bound;
    const { scope, machine, machineReachability, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        error, setError, model, setModel, starting } = bound;
    const modelChoice = useSummaryModelChoice();
    const displayHomeId = scope?.serverId ?? props.serverId;
    // Subscribe to attribution, not heartbeat objects. Exact Home lookup and
    // machine naming stay at their existing owners while the machine is offline.
    const machineName = getStorage()(state => getMachineSentenceName(
        resolveServerScopedMachine(state, displayHomeId, props.displayMachineId ?? '') ?? { absence: 'unlisted' },
    ));
    const observedAtMs = viewModel?.observedAtMs ?? null;
    const offline = capturedComparison && machineReachability === 'unreachable' ? {
        machine: machineName,
        time: observedAtMs === null ? t('common.unavailable')
            : formatWithCachedDateTimeFormatter(observedAtMs, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
    } : null;
    const boundStart = bound.onStart;
    const onStart = React.useCallback(() => boundStart(), [boundStart]);
    const openExplainSetting = useOpenExplainChangesSetting();
    const key = viewModel?.requestKey;
    const runId = viewModel?.executionRunId ?? null;
    const marks = useScmReviewedMarks({ comparison: capturedComparison, serverId: props.serverId ?? null, host: bound.host,
        observation: 'keyed',
        writeUnavailableReason: bound.machineReachable ? null : t('walkthrough.notice.offlineA11y') });
    const layoutPresented = useLayoutPresentationActive();
    const presented = layoutPresented && props.active !== false;
    const evidence = useCapturedComparisonEvidence(capturedComparison, { host: bound.host, serverId: props.serverId, presented });
    const reading = useWalkthroughReading(evidence.comparison
        ? {
            comparison: evidence.comparison,
            walkthrough: viewModel?.outputs?.walkthrough ?? null,
            analysis: viewModel?.analysis ?? null,
            reviewed: marks.record,
            reviewedRecordSource: marks.recordSource,
            provenance: viewModel?.savedResult?.walkthroughProvenance,
        }
        : null, 'keyed');

    const discussion = React.useMemo(() => (props.sessionId
        ? resolveScmDiffSummaryDiscussionTarget({
            sessionId: props.sessionId,
            serverId: props.serverId,
            runId,
            run: viewModel?.latestRun,
            source: 'session_rpc',
            canControlExecutionRuns: canSend,
        })
        : null), [canSend, props.serverId, props.sessionId, runId, viewModel?.latestRun]);
    const onOpenComposer = props.onOpenComposer;
    // An Ask about a stop shows the composer the way every Ask does: over the reading on a phone (lab WT3-D1p).
    const revealAsk = useAskSessionReveal(onOpenComposer);
    const sessionId = props.sessionId;
    const onAsk = React.useMemo(() => {
        if (!sessionId || !onOpenComposer || discussion?.kind !== 'continue' || !scope || !cwd || !viewModel?.savedResult) return props.onAskStop;
        const recipient = discussion.recipient;
        const saved = viewModel.savedResult;
        return (stop: WalkthroughStop, question?: string) => {
            if (!bound.isCurrent()) return;
            const currentText = question ? getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId })?.composer.text.value ?? '' : '';
            writeExistingSessionDraft({ scope, sessionId, patch: { ...(question ? { text: currentText ? `${currentText}\n\n${question}` : question } : {}),
                routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient,
                target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, stopIds: [stop.id] } }) } } });
            revealAsk();
        };
    }, [bound.isCurrent, cwd, discussion, onOpenComposer, revealAsk, props.sessionId, props.onAskStop, scope?.serverId, scope?.accountId, viewModel?.savedResult]);
    const saved = viewModel?.savedResult;
    const updateWitnessed = useWitnessedUpdateNotice(saved, reading?.phase ?? 'none');
    const nativeDiscussionReply = !sessionId ? selectScmDiffSummaryDiscussionReply(viewModel) : null;
    const [undoing, setUndoing] = React.useState(false);
    const undoPending = React.useRef(false);
    const onUndo = React.useMemo(() => saved?.canUndo && operations && cwd && key && canControl
        && !isScmCommitPlanApplicationLocked(saved.application) && !undoing ? () => {
            if (!bound.isCurrent() || undoPending.current) return;
            undoPending.current = true;
            setUndoing(true);
            void operations.undo({ cwd, resultId: saved.resultId, expectedRevision: saved.revision }).then((response) => {
                if (!bound.isCurrent()) return;
                if (response.success) applySavedScmDiffSummaryResult(key, response.result);
                else setError(response.error);
            }).finally(() => { undoPending.current = false; setUndoing(false); });
        } : undefined, [bound.isCurrent, canControl, cwd, key, operations, saved, setError, undoing]);
    const onStartNew = React.useMemo(() => sessionId && onOpenComposer && saved?.generator && cwd && scope && canSend && launch.canLaunchExecutionRuns ? () => {
        if (!bound.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient: null,
            target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, startNew: true } }) } } });
        onOpenComposer();
    } : undefined, [saved, cwd, bound.isCurrent, scope?.serverId, scope?.accountId, canSend, launch.canLaunchExecutionRuns, props.sessionId, onOpenComposer]);
    const onAskSession = React.useCallback(() => {
        if (!sessionId || !onOpenComposer || !scope || !bound.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: null }) } } });
        onOpenComposer();
    }, [bound.isCurrent, scope?.serverId, scope?.accountId, props.sessionId, onOpenComposer]);

    // The generator's own transcript is the existing run destination, never the human discussion thread.
    const router = useRouter();
    const conversationHref = discussion?.kind === 'continue' ? discussion.href : null;
    // Questions asked about a stop, with their answers, read from the generator's transcript under that stop (lab WT3-D1).
    const latestRun = viewModel?.latestRun;
    const exchangeStopIds = React.useMemo(() => reading?.stops.map((stop) => stop.id) ?? [], [reading?.stops]);
    const exchangeSource = React.useMemo<WalkthroughStopExchangesSource | null>(() => (sessionId && runId && saved && latestRun?.runId === runId
        ? { sessionId, runId, sidechainId: latestRun.sidechainId, resultId: saved.resultId, stopIds: exchangeStopIds }
        : null), [exchangeStopIds, latestRun?.runId, latestRun?.sidechainId, runId, saved?.resultId, sessionId]);
    const openConversation = React.useMemo(() => (conversationHref ? () => router.push(conversationHref as never) : null), [conversationHref, router]);
    const phone = props.layout === 'phone';
    // A phone lists it as a named row of the comparison menu; the wide bar keeps the quiet icon.
    const conversationAction = conversationHref && !phone ? (
        <IconButton
            testID="walkthrough-open-conversation"
            variant="plain"
            iconName="chat-circle-dots"
            tooltip={t('walkthrough.openConversation')}
            accessibilityLabel={t('walkthrough.openConversation')}
            onPress={() => router.push(conversationHref as never)}
        />
    ) : null;

    const askStopById = React.useMemo(() => (onAsk && reading
        ? (stopId: string) => { const stop = reading.stops.find((item) => item.id === stopId); if (stop) onAsk(stop); }
        : null), [onAsk, reading]);
    const review = useWalkthroughReview({
        host: bound.host,
        cwd: cwd ?? '',
        scope,
        comparison: capturedComparison,
        walkthrough: viewModel?.outputs?.walkthrough ?? null,
        producer: viewModel?.producer,
        startedReviewRunIds: props.startedReviewRunIds,
    });
    const [explaining, setExplaining] = React.useState(false);
    const reviewView = useSessionWalkthroughReviewPresentation({
        review,
        phase: reading?.phase ?? 'none',
        phone: props.layout === 'phone',
        onAskStop: askStopById,
        scope,
        sessionId: sessionId ?? '',
        onRetryReviewEngines: props.onRetryReviewEngines,
        modelId: viewModel?.producer?.modelId ?? null,
    });
    const savedForExplain = viewModel?.savedResult ?? null;
    const explainTargets = review?.overlay.stops.size ? [...review.overlay.stops.values()].flatMap((stop) => stop.cards) : [];
    const onExplain = React.useMemo(() => (review && savedForExplain && cwd && canSend && explainTargets.length > 0 && reading?.phase === 'complete'
        ? async () => {
            if (!bound.isCurrent()) return;
            setExplaining(true);
            const done = await requestExplainReviewFindings({
                ...(bound.host.sessionId ? { sessionId: bound.host.sessionId } : { sessionId: null, machineId: bound.host.machineId! }),
                serverId: scope?.serverId ?? props.serverId ?? null, accountId: scope?.accountId, cwd,
                runId: viewModel?.producer?.runId ?? review.reviewRunIds[0]!, reviewRunIds: review.reviewRunIds,
                resultId: savedForExplain.resultId, expectedRevision: savedForExplain.revision,
                findingIds: explainTargets.map((view) => ({ runId: view.runId, findingId: view.findingId })),
            }).catch((cause: unknown) => ({ ok: false as const, ...normalizeActionExecutorThrownError(cause, 'review.explain_findings') }));
            if (!bound.isCurrent()) return;
            setExplaining(false);
            if (!done.ok) {
                const failure = readActionFailureEnvelope(done);
                alertActionFailure({ reason: failure ? presentActionExecutionFailure(failure).reason : done.error,
                    code: failure?.errorCode ?? null, requestId: failure?.requestId, failureCause: failure?.failureCause,
                    context: readSafeFailureDetails(failure?.details) });
            }
        }
        : null), [bound.isCurrent, bound.host.sessionId, bound.host.machineId, canSend, cwd, explainTargets, props.serverId, scope, reading?.phase, review, savedForExplain, setError, viewModel?.producer?.runId]);
    // A walkthrough the review wrote already reads with its findings (lab WT5-R6): Explain is offered only over a
    // walkthrough written before or apart from the review (WT5-R2).
    const explainOffered = onExplain && viewModel?.producer?.kind !== 'review';
    const explainAction = review && (explainOffered || explaining)
        ? <ReviewExplainFindingsButton running={explaining} onPress={() => { if (onExplain) void onExplain(); }} /> : null;
    const reviewStatus = review ? <ReviewWalkthroughSteps progress={review.progress} phone={phone} /> : null;

    const { theme } = useUnistyles();
    const { backendTarget: producerTarget, modelId: producerModelId, selection: producerSelection } = selectScmDiffSummaryProducerModel(viewModel);
    const markAgentId = resolveExecutionRunAgentMarkId(producerTarget, theme);
    // Who wrote the reading, by name ("Opus 5.5 read all 14"): the model when the result records it, else the
    // Agent beside its mark ("Codex read all 2"), and only then the generic "The model".
    const { engine: producerEngine } = useRunAnsweringEngine({ backendTarget: producerTarget, modelId: producerModelId,
        selection: producerSelection, sessionId: props.sessionId, serverId: props.serverId,
        machineId: bound.host.machineId, cwd });
    const producerLabel = React.useMemo(() => {
        if (producerEngine) return producerEngine.label;
        try { return resolveExecutionRunBackendLabel(producerTarget); } catch { return null; }
    }, [producerEngine, producerTarget]);
    const marksReadable = capturedComparison !== null && marks.record !== null;
    const setReviewed = marks.setReviewed;
    const onToggleReviewed = React.useMemo(() => (marksReadable
        ? (stop: WalkthroughStop) => setReviewed(stop.changeRefs, !stop.reviewed)
        : undefined), [marksReadable, setReviewed]);

    // The saved result's operations are rows of the comparison menu; what they open renders under the header.
    const savedActions = useWalkthroughSavedActions(saved && cwd && key && operations ? {
        result: saved, cwd, operations,
        editorKey: JSON.stringify([scope?.serverId, scope?.accountId, bound.host.sessionId, bound.host.machineId, cwd, saved.resultId]),
        paneScopeId: bound.paneScopeId,
        nativeDiscussion: !sessionId,
        nativeDiscussionReply,
        onUndo, undoing,
        undoInNotice: Boolean(updateWitnessed && onUndo),
        phone: props.layout === 'phone',
        canGenerate: canSend && launch.canLaunchExecutionRuns,
        disabledReason: !canControl ? t('walkthroughStart.unavailable') : null,
        onResult: (result) => { if (bound.isCurrent()) applySavedScmDiffSummaryResult(key, result); },
        onError: (failure) => { if (bound.isCurrent()) setError(failure.error); },
    } : null);
    // Find over the reading: the Files view's control, as the wide bar's icon and a phone menu row.
    const findSurfaceInstance = React.useId();
    const findSurfaceId = `walkthrough:${findSurfaceInstance}`;
    const findRuntime = useFindSurfaceRuntime();
    const findAvailable = Boolean(reading && reading.stops.length + reading.others.length > 0);
    const findAction = findAvailable && !phone ? <ChangedFilesReviewFindButton surfaceId={findSurfaceId} /> : null;
    const findSection = React.useMemo<ScmComparisonMenuSection | null>(() => (findAvailable && phone ? {
        id: 'find',
        items: [{ id: 'open', testID: 'scm-review-find', title: t('find.surface.changes'),
            icon: <Icon name="magnifying-glass" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }],
        onSelect: () => { findRuntime.open(findSurfaceId); },
    } : null), [findAvailable, findRuntime, findSurfaceId, phone, theme.colors.text.secondary]);
    const conversationSection = React.useMemo<ScmComparisonMenuSection | null>(() => (conversationHref && phone ? {
        id: 'conversation',
        items: [{ id: 'open', testID: 'walkthrough-open-conversation', title: t('walkthrough.openConversation'),
            icon: <Icon name="chat-circle-dots" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }],
        onSelect: () => router.push(conversationHref as never),
    } : null), [conversationHref, phone, router, theme.colors.text.secondary]);
    const savedSections = React.useMemo(() => {
        const sections = [findSection, conversationSection, savedActions.section].filter((section): section is ScmComparisonMenuSection => Boolean(section));
        return sections.length > 0 ? sections : undefined;
    }, [findSection, conversationSection, savedActions.section]);
    const notifySource = runId ? sessionId ? { kind: 'execution_run' as const, sessionId, runId }
        : machine?.machineId ? { kind: 'execution_run' as const, machineId: machine.machineId, runId } : null : null;

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {props.renderBar(<>{explainAction}{findAction}{conversationAction}</>, savedSections, reviewStatus)}
            {modelChoice.choosing ? <LlmTaskRunnerPicker task="scm_diff_summary" presentation="chips" engineFieldTitle={null} value={model} onChange={setModel}
                machineId={machine?.machineId ?? null} serverId={props.serverId ?? null} sessionAgentTargetKey={bound.sessionAgentTargetKey}
                testIDPrefix="walkthrough-model-choice" /> : null}
            <WalkthroughStopExchangesProvider source={exchangeSource} modelLabel={producerLabel} onOpenConversation={openConversation}>
            <WalkthroughView
                reading={reading ?? EMPTY_WALKTHROUGH_READING}
                presentFileEvidence={evidence.present}
                restoreState={bound.restoreState}
                onRetryRestore={bound.retryRestore}
                admission={bound.admission}
                onCheckAdmission={bound.checkAdmission}
                scopeLabel={props.scopeLabel}
                scopeDetail={props.scopeDetail}
                modelLabel={producerLabel}
                analysisMark={markAgentId ? <AgentIcon agentId={markAgentId} size={ICON_SIZE.xs} /> : null}
                generatedLabel={reviewView?.generatedLabel ?? null}
                review={reviewView?.slots ?? null}
                layout={props.layout}
                active={presented}
                offline={offline}
                onToggleReviewed={onToggleReviewed}
                marksDisabledReason={marks.unavailableReason}
                reviewedProgressAvailable={marksReadable}
                reviewedProgressPending={marks.pending}
                onAsk={onAsk}
                askPending={Boolean(sessionId && onOpenComposer && runId && discussion?.kind === 'unknown')}
                onOpenFile={props.onOpenFile}
                onShowFiles={props.onShowFiles}
                // The band is the way back from the last change; without Undo the reading's own provenance marks carry it.
                update={updateWitnessed && onUndo ? { title: t('walkthrough.saved.updated'), onUndo } : null}
                stale={capturedComparison?.freshness === 'stale' ? { ...(canSend && launch.canLaunchExecutionRuns ? { onRefresh: () => {
                    if (!bound.isCurrent()) return;
                    void onStart();
                } } : {}) } : null}
                start={{ options: <ScmDiffSummaryStartOptions {...scmDiffSummaryStartOptionsOf(bound, { testID: 'walkthrough-start-options', modelTestID: 'walkthrough-model-choice',
                        prerequisite: scmDiffSummaryPrerequisiteOf(bound),
                        onEnableExplain: openExplainSetting })} />,
                    onStart, busy: starting, disabled: Boolean(bound.startBlocker) || !canSend || !launch.canLaunchExecutionRuns }}
                failure={bound.generationFailure}
                onEnableExplain={openExplainSetting}
                onRetry={bound.admission ? undefined : onStart}
                onChooseModel={modelChoice.choose}
                endedConversation={saved && sessionId && discussion?.kind === 'unavailable' ? { onStartNew, onAskSession } : null}
                notify={notifySource && capturedComparison && viewModel?.resultId
                    ? <RunWorkNotifications serverId={props.serverId}
                        source={notifySource}
                        selectedOutput={{ output: 'walkthrough', comparisonId: capturedComparison.id, resultId: viewModel.resultId }} /> : null}
                savedActions={savedActions.panel}
                findSurfaceId={findSurfaceId}
                hosted={props.hosted}
            />
            </WalkthroughStopExchangesProvider>
        </View>
    );
});

/**
 * "Saved result updated · Undo" confirms an update this view saw arrive (a merge, an edit, a regeneration).
 * A notice already on the result when the view first showed it is history: the stops' own changed marks
 * carry it, and Undo stays in the comparison menu, so the band doesn't sit on the page indefinitely.
 * Revisions that land while the first reading is still being written (the inventory, then its prose arriving)
 * are that reading arriving, not an update to one the person was already reading, so they move the baseline.
 */
function useWitnessedUpdateNotice(
    saved: Readonly<{ resultId: string; revision: number; updateNotice?: Readonly<{ revision: number }> }> | null | undefined,
    phase: WalkthroughPhase,
): boolean {
    const [baseline, setBaseline] = React.useState<Readonly<{ resultId: string; revision: number; readable: boolean }> | null>(null);
    const readable = phase !== 'none' && phase !== 'inventory' && phase !== 'arriving';
    const current = !saved ? baseline
        : baseline?.resultId !== saved.resultId || (!baseline.readable && (saved.revision > baseline.revision || readable))
            ? { resultId: saved.resultId, revision: saved.revision, readable }
            : baseline;
    if (current !== baseline) setBaseline(current);
    return Boolean(saved?.updateNotice && current && saved.updateNotice.revision > current.revision);
}
