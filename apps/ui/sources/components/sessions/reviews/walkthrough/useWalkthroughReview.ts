import * as React from 'react';
import { projectReviewFindingsOverlay, type ReviewFindingsOverlayReview } from '@happier-dev/protocol/reviews/projectReviewFindingsOverlay';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewCommentAnchorV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewFindingsV1 } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import type { ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryOutputState, ScmDiffSummaryReviewRun, ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

import { readReviewPayload } from '@/components/sessions/reviews/findings/readReviewPayload';
import { resolveReviewRunOutput, resolveReviewRunStatus } from '@/components/sessions/reviews/findings/resolveReviewRunStatus';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { resolveEffectiveReviewFindings } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { useSessionMessages } from '@/sync/domains/state/storage';
import { sessionExecutionRunGet } from '@/sync/ops/sessionExecutionRuns';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { loadReviewRunComments, reviewRunCommentsTargetFromFindings } from '@/sync/domains/reviews/comments/reviewRunComments';

import { buildWalkthroughReviewOverlay, type WalkthroughReviewOverlay } from './reviewWalkthroughOverlay';
import { resolveReviewWalkthroughProgress, type ReviewWalkthroughProgress } from './reviewWalkthroughProgress';

type ReviewRunRead = Readonly<{
    runId: string;
    run: ExecutionRunPublicState | null;
    payload: ReviewFindingsV1 | ReviewFindingsV2 | null;
    state: 'loading' | 'readable' | 'unread' | 'failed';
}>;

export type WalkthroughReviewProducer = Readonly<{
    kind: 'generation' | 'review';
    runId?: string;
    modelId?: string;
    reviewedRuns?: readonly ScmDiffSummaryReviewRun[];
    narrationMode?: 'continued_review' | 'seeded_narrator';
    comparisonFreshness?: 'unchanged' | 'changed' | 'unknown';
    narratedAtMs?: number;
}> | null | undefined;

export type WalkthroughReviewState = Readonly<{
    overlay: WalkthroughReviewOverlay;
    progress: ReviewWalkthroughProgress;
    reviewRunIds: readonly string[];
    /** Each reviewer's comment snapshot: the durable triage of every finding. */
    comments: ReturnType<typeof useReviewRunsComments>;
    reviewerLabelByRunId: Readonly<Record<string, string>>;
    readStateByRunId: Readonly<Record<string, ReviewRunRead['state']>>;
    narrationMode: 'continued_review' | 'seeded_narrator' | null;
    /** When the review that a seeded narrator read finished ("11:04"). */
    reviewedAtMs: number | null;
    comparisonFreshness: 'unchanged' | 'changed' | 'unknown' | null;
    retry(): Promise<void>;
}>;

const NO_READS: readonly ReviewRunRead[] = Object.freeze([]);

/**
 * A walkthrough's review (Walkthrough lab WT5): the reviewer Runs a review-produced result names (or the
 * ones a start just launched), each Run's own result and status read through the Run host, findings made
 * effective by their follow-ups, placed by the protocol overlay. Reading never calls a model; it refreshes
 * on the canonical Run activity signal.
 */
export function useWalkthroughReview(params: Readonly<{
    host: ScmDiffSummaryHost;
    cwd: string;
    scope: ServerAccountScope | null;
    comparison: ScmComparison | null;
    walkthrough: Readonly<{ state: ScmDiffSummaryOutputState; value?: ScmDiffSummaryWalkthrough }> | null;
    producer: WalkthroughReviewProducer;
    /** Reviewer Runs a start from this view launched, before the result names them. */
    startedReviewRunIds?: readonly string[] | null;
}>): WalkthroughReviewState | null {
    const { comparison, walkthrough, producer } = params;
    const sessionId = params.host.sessionId ?? '';
    const machineId = params.host.machineId ?? null;
    const serverId = params.scope?.serverId ?? null;
    const accountId = params.scope?.accountId ?? null;
    const scope = React.useMemo(() => (serverId && accountId ? { serverId, accountId } : null), [accountId, serverId]);
    const runKey = [...new Set([
        ...(producer?.kind === 'review' ? producer.reviewedRuns ?? [] : []).map((run) => run.runId),
        ...(params.startedReviewRunIds ?? []),
    ])].join('\u0000');
    const runIds = React.useMemo(() => (runKey ? runKey.split('\u0000') : []), [runKey]);
    const readKey = JSON.stringify([serverId, accountId, sessionId, machineId, params.cwd, runKey,
        producer?.narratedAtMs, producer?.reviewedRuns?.map(run => [run.runId, run.status, run.hasOutput])]);

    const [reads, setReads] = React.useState<Readonly<{ key: string; reads: readonly ReviewRunRead[] }>>({ key: '', reads: NO_READS });
    const [retryVersion, setRetryVersion] = React.useState(0);
    React.useEffect(() => {
        if (!scope || runIds.length === 0 || (!sessionId && !machineId)) return;
        let current = true;
        let loading = false;
        const selectedRunIds = new Set(runIds);
        const pendingRunIds = new Set<string>();
        const load = async (requestedRunIds: readonly string[] = runIds) => {
            if (!current) return;
            for (const runId of requestedRunIds) pendingRunIds.add(runId);
            if (loading) return;
            loading = true;
            setReads((previous) => previous.key === readKey ? previous : ({
                key: readKey,
                reads: runIds.map((runId) => ({ runId, run: null, payload: null, state: 'loading' })),
            }));
            while (current && pendingRunIds.size > 0) {
                const requested = [...pendingRunIds];
                pendingRunIds.clear();
                const next = await Promise.all(requested.map(async (runId): Promise<ReviewRunRead> => {
                    const got = await (sessionId
                        ? sessionExecutionRunGet(sessionId, { runId, includeStructured: true, includeLatestToolResult: false }, { serverId: scope.serverId, scope })
                        : createDefaultActionExecutor().execute('execution.run.get', { sessionId: null, runId, includeStructured: true, includeLatestToolResult: false }, {
                            serverId: scope.serverId, expectedAccountId: scope.accountId, executionRunTargetMachineId: machineId!,
                            externalActionTarget: { kind: 'machine', machineId: machineId!, project: { machineId: machineId!, directory: params.cwd } },
                        }).then(result => result.ok ? ExecutionRunGetResponseSchema.parse(result.result) : null))
                        .catch(() => null);
                    const payload = got && 'run' in got ? readReviewPayload(got.structuredMeta, got.reviewFindings) : null;
                    return got && 'run' in got
                        ? { runId, run: got.run, payload, state: payload ? 'readable' : 'unread' }
                        : { runId, run: null, payload: null, state: 'failed' };
                }));
                if (current) setReads((previous) => {
                    const previousReads = previous.key === readKey ? previous.reads : NO_READS;
                    const updatesByRunId = new Map(next.map(read => [read.runId, read]));
                    const incoming = previousReads.map(last => {
                        const read = updatesByRunId.get(last.runId);
                        if (!read) return last;
                        return read.state === 'readable' ? read : { ...read, run: read.run ?? last.run, payload: last.payload };
                    });
                    const nextReads = retainKeyedRows(previousReads, incoming, read => read.runId);
                    return previous.key === readKey && nextReads === previous.reads ? previous : { key: readKey, reads: nextReads };
                });
            }
            loading = false;
        };
        fireAndForget(load(), { tag: 'useWalkthroughReview.load' });
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ serverId: scope.serverId, sessionId }, (notification) => {
            if (notification.runId !== null && !selectedRunIds.has(notification.runId)) return;
            fireAndForget(load(notification.runId === null ? runIds : [notification.runId]), { tag: 'useWalkthroughReview.refresh' });
        }) : () => {};
        return () => { current = false; unsubscribe(); };
    }, [runIds, readKey, scope, sessionId, machineId, params.cwd, retryVersion]);
    const runReads = reads.key === readKey ? reads.reads : NO_READS;
    const commentRunIds = React.useMemo(() => runReads.filter(read => read.state !== 'loading').map(read => read.runId), [runReads]);
    const reviewIdsByRunId = React.useMemo(() => Object.fromEntries(runReads.flatMap(read => read.payload
        ? [[read.runId, reviewRunCommentsTargetFromFindings(read.payload).reviewId]] : [])), [runReads]);

    const commentIdsByRunId = React.useMemo(() => Object.fromEntries(runIds.map(runId => [
        runId, [...new Set([
            ...(producer?.kind === 'review' ? producer.reviewedRuns?.find(run => run.runId === runId)?.commentIds ?? [] : []),
            ...(runReads.find(read => read.runId === runId)?.payload?.findings ?? []).flatMap(finding => finding.comment ? [finding.comment.id] : []),
        ])],
    ])), [runIds, runReads, producer]);
    const comments = useReviewRunsComments({ scope: sessionId ? scope : null, sessionId, runIds: commentRunIds, reviewIdsByRunId, commentIdsByRunId, enabled: Boolean(sessionId) && commentRunIds.length > 0 });
    // Effective findings read structured follow-up meta, never streamed text.
    const { messages } = useSessionMessages(sessionId, { enabled: Boolean(sessionId) && runIds.length > 0, textUpdates: false });
    const retry = React.useCallback(async () => {
        setRetryVersion(version => version + 1);
        if (scope && sessionId) await Promise.all(commentRunIds.map(runId => loadReviewRunComments({ scope, sessionId, runId,
            ...(reviewIdsByRunId[runId] ? { reviewId: reviewIdsByRunId[runId] } : {}),
            commentIds: commentIdsByRunId[runId] }).catch(() => undefined)));
    }, [scope, sessionId, commentRunIds, reviewIdsByRunId, commentIdsByRunId]);

    return React.useMemo(() => {
        if (runIds.length === 0) return null;
        const producerRuns = producer?.kind === 'review' ? producer.reviewedRuns ?? [] : [];
        const reviewerLabelByRunId: Record<string, string> = {};
        const readStateByRunId: Record<string, ReviewRunRead['state']> = {};
        const outputReadStateByRunId: Record<string, 'ready' | 'loading' | 'unavailable'> = {};
        const reviews = runIds.map((runId): ReviewFindingsOverlayReview => {
            const read = runReads.find((entry) => entry.runId === runId);
            const recorded = producerRuns.find((run) => run.runId === runId);
            const payload = read?.payload ?? null;
            const readState = read?.state ?? 'loading';
            readStateByRunId[runId] = readState;
            const backendTarget = read?.run?.backendTarget ?? null;
            reviewerLabelByRunId[runId] = resolveExecutionRunBackendLabel(backendTarget)
                ?? payload?.runRef.backendId ?? recorded?.backendId ?? runId;
            const runRef = payload?.runRef ?? { runId, callId: read?.run?.callId ?? recorded?.callId ?? runId, backendId: recorded?.backendId ?? '' };
            const snapshot = comments[commentRunIds.indexOf(runId)];
            const output = resolveReviewRunOutput({ payload, recorded, comments: snapshot });
            outputReadStateByRunId[runId] = output.readState;
            const findings = payload ? resolveEffectiveReviewFindings({ runRef, initialFindings: payload.findings, messages }).findings : output.findings;
            const anchorsByFindingId: Record<string, ReviewCommentAnchorV1> = {};
            for (const comment of snapshot?.comments ?? []) {
                if (comment.findingId) anchorsByFindingId[comment.findingId] = comment.anchor;
            }
            const status = resolveReviewRunStatus({ run: read?.run, payload, recorded });
            return {
                runRef,
                comparisonId: (payload && 'comparisonId' in payload && typeof payload.comparisonId === 'string' ? payload.comparisonId : undefined) ?? recorded?.comparisonId,
                findings,
                ...(status ? { status } : {}),
                hasOutput: output.hasOutput,
                ...(output.reviewOutcome ? { reviewOutcome: output.reviewOutcome } : {}),
                ...(payload && 'limits' in payload && payload.limits?.findingsTruncated ? { findingsTruncated: true } : {}),
                anchorsByFindingId,
            };
        });
        const overlay = buildWalkthroughReviewOverlay({
            overlay: projectReviewFindingsOverlay({ comparison, walkthrough: walkthrough?.value ?? null, reviews }),
            stops: walkthrough?.value?.stops ?? [],
            reviewerLabelByRunId,
            readStateByRunId: outputReadStateByRunId,
        });
        const narrationMode = producer?.kind === 'review' ? producer.narrationMode ?? null : null;
        const producerRunId = producer?.kind === 'review' ? producer.runId ?? null : null;
        const findingsOnlyReviewer = runIds.length === 1 && narrationMode !== 'seeded_narrator'
            && producerRunId !== null && producerRunId !== runIds[0];
        const finishedAt = runReads.reduce((max, read) => Math.max(max, read.payload?.generatedAtMs ?? read.run?.finishedAtMs ?? 0), 0);
        const progress = resolveReviewWalkthroughProgress({
            review: overlay.summary,
            narration: walkthrough ? {
                state: walkthrough.state,
                mode: narrationMode,
                narratorLabel: producer?.modelId ?? null,
                findingsOnlyReviewer,
            } : null,
        });
        return {
            overlay,
            progress,
            reviewRunIds: runIds,
            comments,
            reviewerLabelByRunId,
            readStateByRunId,
            narrationMode,
            reviewedAtMs: finishedAt > 0 ? finishedAt : null,
            comparisonFreshness: producer?.kind === 'review' ? producer.comparisonFreshness ?? null : null,
            retry,
        };
    }, [comments, commentRunIds, comparison, messages, producer, runIds, runReads, walkthrough, retry]);
}
