import * as React from 'react';
import { View } from 'react-native';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import { useRouter } from 'expo-router';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { getPreferredLanguage, t } from '@/text';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { resolveScmDiffSummaryDiscussionTarget } from '@/sync/domains/scm/diffSummary/discussion';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { ScmDiffSummaryModelPicker } from '@/components/settings/sourceControl/ScmDiffSummaryModelPicker';
import { applySavedScmDiffSummaryResult } from '@/sync/ops/scmDiffSummary/generate';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { WalkthroughView, type WalkthroughViewLayout } from './WalkthroughView';
import { buildWalkthroughReading, EMPTY_WALKTHROUGH_READING, type WalkthroughStop } from './walkthroughReading';
import { useWalkthroughReviewedMarks } from './useWalkthroughReviewedMarks';
import { WalkthroughSavedActions } from './WalkthroughSavedActions';
import { useWalkthroughReview } from '@/components/sessions/reviews/walkthrough/useWalkthroughReview';
import { ReviewExplainFindingsButton, useSessionWalkthroughReviewPresentation } from '@/components/sessions/reviews/walkthrough/SessionWalkthroughReview';
import { ReviewWalkthroughSteps } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { requestExplainReviewFindings } from '@/sync/ops/reviews/reviewWalkthrough';

export type SessionWalkthroughViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    comparison: SessionScmReviewComparison | null;
    scopeLabel: string;
    scopeDetail?: string | null;
    layout: WalkthroughViewLayout;
    active?: boolean;
    /** The comparison bar, drawn by the review destination above every view, with this view's own actions. */
    renderBar: (actions: React.ReactNode) => React.ReactNode;
    onShowFiles: () => void;
    onOpenFile: (path: string) => void;
    /** Hands the person to the Session composer, whose recipient now names the generator. */
    onOpenComposer: () => void;
    /** Reviewer Runs a Start review from this comparison launched, before the saved result names them. */
    startedReviewRunIds?: readonly string[] | null;
    /** Start review again with these engines selected (a partial review's failed reviewer). */
    onRetryReviewEngines?: (engineIds: readonly string[]) => void;
}>;

/**
 * The Walkthrough view bound to a Session: the comparison's walkthrough analysis from the one diff-summary
 * store, the person's marks from Account KV, and Discuss through the generating run's real affordances.
 */
export const SessionWalkthroughView = React.memo(function SessionWalkthroughView(props: SessionWalkthroughViewProps) {
    // The comparison's saved result, restore/reread and START: the one binding Walkthrough and Commits share.
    const bound = useSessionScmDiffSummaryBinding({ sessionId: props.sessionId, serverId: props.serverId, comparison: props.comparison, output: 'walkthrough' });
    const { binding, scope, machine, machineReachable, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        error, setError, model, setModel, onModelAvailability, modelAvailable, selected, starting } = bound;
    const displayHomeId = scope?.serverId ?? props.serverId;
    const displayIdentity = useSessionMachineDisplayIdentity(props.sessionId, displayHomeId);
    // Subscribe to attribution, not heartbeat objects. Exact Home lookup and
    // machine naming stay at their existing owners while the machine is offline.
    const machineName = getStorage()(state => getMachineDisplayName(
        resolveServerScopedMachine(state, displayHomeId, displayIdentity.machineId) ?? { absence: 'unlisted' },
    ));
    const observedAtMs = viewModel?.observedAtMs ?? null;
    const offline = capturedComparison && !machineReachable ? {
        machine: machineName,
        time: observedAtMs === null ? t('common.unavailable')
            : formatWithCachedDateTimeFormatter(observedAtMs, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
    } : null;
    const boundStart = bound.onStart;
    const onStart = React.useCallback(() => boundStart(), [boundStart]);
    const [choosingModel, setChoosingModel] = React.useState(false);
    const key = viewModel?.requestKey;
    const runId = viewModel?.executionRunId ?? null;
    const marks = useWalkthroughReviewedMarks({ comparison: capturedComparison, serverId: props.serverId ?? null });
    const reading = React.useMemo(() => (capturedComparison
        ? buildWalkthroughReading({
            comparison: capturedComparison,
            walkthrough: viewModel?.outputs?.walkthrough ?? null,
            analysis: viewModel?.analysis ?? null,
            reviewed: marks.record?.comparisonId === capturedComparison.id ? marks.record : null,
            provenance: viewModel?.savedResult?.walkthroughProvenance,
        })
        : null), [capturedComparison, marks.record, viewModel?.analysis, viewModel?.outputs?.walkthrough, viewModel?.savedResult?.walkthroughProvenance]);

    const discussion = React.useMemo(() => (runId
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
    const onAsk = React.useMemo(() => {
        if (discussion?.kind !== 'continue' || !scope || !cwd || !viewModel?.savedResult) return undefined;
        const recipient = discussion.recipient;
        const saved = viewModel.savedResult;
        return (stop: WalkthroughStop) => {
            if (!binding?.isCurrent()) return;
            writeExistingSessionDraft({ scope, sessionId: props.sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient,
                target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, stopIds: [stop.id] } }) } } });
            onOpenComposer();
        };
    }, [binding, cwd, discussion, onOpenComposer, props.sessionId, scope?.serverId, scope?.accountId, viewModel?.savedResult]);
    const saved = viewModel?.savedResult;
    const [undoing, setUndoing] = React.useState(false);
    const undoPending = React.useRef(false);
    const onUndo = React.useMemo(() => saved?.canUndo && operations && cwd && key && canControl
        && !isScmCommitPlanApplicationLocked(saved.application) && !undoing ? () => {
            if (!binding?.isCurrent() || undoPending.current) return;
            undoPending.current = true;
            setUndoing(true);
            void operations.undo({ cwd, resultId: saved.resultId, expectedRevision: saved.revision }).then((response) => {
                if (!binding.isCurrent()) return;
                if (response.success) applySavedScmDiffSummaryResult(key, response.result);
                else setError(response.error);
            }).finally(() => { undoPending.current = false; setUndoing(false); });
        } : undefined, [binding, canControl, cwd, key, operations, saved, setError, undoing]);
    const onStartNew = React.useMemo(() => saved?.generator && cwd && scope && canSend && launch.canLaunchExecutionRuns ? () => {
        if (!binding?.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId: props.sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'scm_diff_summary', recipient: null,
            target: { cwd, resultId: saved.resultId, expectedRevision: saved.revision, startNew: true } }) } } });
        onOpenComposer();
    } : undefined, [saved, cwd, binding, scope?.serverId, scope?.accountId, canSend, launch.canLaunchExecutionRuns, props.sessionId, onOpenComposer]);
    const onAskSession = React.useCallback(() => {
        if (!scope || !binding?.isCurrent()) return;
        writeExistingSessionDraft({ scope, sessionId: props.sessionId, patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: null }) } } });
        onOpenComposer();
    }, [binding, scope?.serverId, scope?.accountId, props.sessionId, onOpenComposer]);

    // The generator's own transcript is the existing run destination, never the human discussion thread.
    const router = useRouter();
    const conversationHref = discussion?.kind === 'continue' ? discussion.href : null;
    const conversationAction = conversationHref ? (
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
        sessionId: props.sessionId,
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
        sessionId: props.sessionId,
        onRetryReviewEngines: props.onRetryReviewEngines,
        modelId: viewModel?.producer?.modelId ?? null,
    });
    const savedForExplain = viewModel?.savedResult ?? null;
    const explainTargets = review?.overlay.stops.size ? [...review.overlay.stops.values()].flatMap((stop) => stop.cards) : [];
    const onExplain = React.useMemo(() => (review && savedForExplain && cwd && canSend && explainTargets.length > 0 && reading?.phase === 'complete'
        ? async () => {
            if (!binding?.isCurrent()) return;
            setExplaining(true);
            const done = await requestExplainReviewFindings({
                sessionId: props.sessionId, serverId: props.serverId ?? null, cwd,
                runId: viewModel?.producer?.runId ?? review.reviewRunIds[0]!, reviewRunIds: review.reviewRunIds,
                resultId: savedForExplain.resultId, expectedRevision: savedForExplain.revision,
                findingIds: explainTargets.map((view) => ({ runId: view.runId, findingId: view.findingId })),
            }).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : t('common.requestFailed') }));
            if (!binding.isCurrent()) return;
            setExplaining(false);
            if (!done.ok) setError(done.error);
        }
        : null), [binding, canSend, cwd, explainTargets, props.serverId, props.sessionId, reading?.phase, review, savedForExplain, setError, viewModel?.producer?.runId]);
    const reviewActions = review ? (
        <>
            {onExplain ? <ReviewExplainFindingsButton running={explaining} onPress={() => { void onExplain(); }} /> : null}
            <ReviewWalkthroughSteps progress={review.progress} />
        </>
    ) : null;

    const marksAvailable = marks.record?.comparisonId === capturedComparison?.id && marks.record !== null && marks.unavailableReason === null;
    const setReviewed = marks.setReviewed;
    const onToggleReviewed = React.useMemo(() => (marksAvailable
        ? (stop: WalkthroughStop) => setReviewed(stop.changeRefs, !stop.reviewed)
        : undefined), [marksAvailable, setReviewed]);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {props.renderBar(<>{reviewActions}{conversationAction}</>)}
            {choosingModel ? <ScmDiffSummaryModelPicker value={model} onChange={setModel} onAvailabilityChange={onModelAvailability} machineId={machine?.machineId} serverId={props.serverId} /> : null}
            <WalkthroughView
                reading={reading ?? EMPTY_WALKTHROUGH_READING}
                scopeLabel={props.scopeLabel}
                scopeDetail={props.scopeDetail}
                modelLabel={viewModel?.producer?.modelId ?? null}
                generatedLabel={reviewView?.generatedLabel ?? null}
                review={reviewView?.slots ?? null}
                layout={props.layout}
                active={props.active}
                offline={offline}
                onToggleReviewed={onToggleReviewed}
                reviewedProgressAvailable={marksAvailable}
                onAsk={onAsk}
                onOpenFile={props.onOpenFile}
                onShowFiles={props.onShowFiles}
                update={saved?.updateNotice ? { message: t('walkthrough.saved.updated'), onUndo } : null}
                stale={capturedComparison?.freshness === 'stale' ? { ...(canSend && launch.canLaunchExecutionRuns ? { onRefresh: () => {
                    if (!binding?.isCurrent()) return;
                    if (!selected.success || !modelAvailable) setChoosingModel(true);
                    else void onStart();
                } } : {}) } : null}
                start={{ modelPicker: <ScmDiffSummaryModelPicker value={model} onChange={setModel} onAvailabilityChange={onModelAvailability} machineId={machine?.machineId} serverId={props.serverId} testID="walkthrough-model-choice" />,
                    onStart, busy: starting, disabled: !selected.success || !modelAvailable || !canSend || !launch.canLaunchExecutionRuns,
                    reason: error ?? (!selected.success || !modelAvailable || !canSend || !launch.canLaunchExecutionRuns ? t('walkthroughStart.unavailable') : null) }}
                onRetry={onStart}
                onChooseModel={() => setChoosingModel(true)}
                endedConversation={saved && discussion?.kind !== 'continue' ? { onStartNew, onAskSession } : null}
                savedActions={saved && cwd && key && operations ? <WalkthroughSavedActions result={saved} cwd={cwd} operations={operations}
                    onUndo={onUndo} undoing={undoing}
                    canGenerate={canSend && launch.canLaunchExecutionRuns}
                    disabledReason={!canControl ? t('walkthroughStart.unavailable') : null}
                    onResult={(result) => { if (binding?.isCurrent()) applySavedScmDiffSummaryResult(key, result); }}
                    onError={(failure) => { if (binding?.isCurrent()) setError(failure.error); }} /> : null}
            />
        </View>
    );
});
