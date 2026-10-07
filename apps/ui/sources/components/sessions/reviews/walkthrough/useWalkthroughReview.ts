import * as React from 'react';
import {
    projectReviewFindingsOverlay,
    type ExecutionRunPublicState,
    type ReviewCommentAnchorV1,
    type ReviewFindingsOverlayReview,
    type ReviewFindingsV1,
    type ReviewFindingsV2,
    type ScmComparison,
    type ScmDiffSummaryOutputState,
    type ScmDiffSummaryReviewRun,
    type ScmDiffSummaryWalkthrough,
} from '@happier-dev/protocol';

import { readReviewPayload } from '@/components/sessions/reviews/findings/useReviewGroupSiblings';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { resolveEffectiveReviewFindings } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionMessages } from '@/sync/domains/state/storage';
import { sessionExecutionRunGet } from '@/sync/ops/sessionExecutionRuns';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
}>;

const NO_READS: readonly ReviewRunRead[] = Object.freeze([]);

/** A V2 result's own review outcome (V1 results carry none). */
function readReviewOutcome(payload: ReviewFindingsV1 | ReviewFindingsV2 | null): 'complete' | 'partial' | 'failed' | null {
    const outcome = payload && 'reviewOutcome' in payload ? payload.reviewOutcome : null;
    return outcome === 'complete' || outcome === 'partial' || outcome === 'failed' ? outcome : null;
}

/**
 * A walkthrough's review (Walkthrough lab WT5): the reviewer Runs a review-produced result names (or the
 * ones a start just launched), each Run's own result and status read through the Run host, findings made
 * effective by their follow-ups, placed by the protocol overlay. Reading never calls a model; it refreshes
 * on the canonical Run activity signal.
 */
export function useWalkthroughReview(params: Readonly<{
    sessionId: string;
    scope: ServerAccountScope | null;
    comparison: ScmComparison | null;
    walkthrough: Readonly<{ state: ScmDiffSummaryOutputState; value?: ScmDiffSummaryWalkthrough }> | null;
    producer: WalkthroughReviewProducer;
    /** Reviewer Runs a start from this view launched, before the result names them. */
    startedReviewRunIds?: readonly string[] | null;
}>): WalkthroughReviewState | null {
    const { sessionId, comparison, walkthrough, producer } = params;
    const serverId = params.scope?.serverId ?? null;
    const accountId = params.scope?.accountId ?? null;
    const scope = React.useMemo(() => (serverId && accountId ? { serverId, accountId } : null), [accountId, serverId]);
    const runKey = [...new Set([
        ...(producer?.kind === 'review' ? producer.reviewedRuns ?? [] : []).map((run) => run.runId),
        ...(params.startedReviewRunIds ?? []),
    ])].join('\u0000');
    const runIds = React.useMemo(() => (runKey ? runKey.split('\u0000') : []), [runKey]);
    const readKey = JSON.stringify([serverId, accountId, sessionId, runKey]);

    const [reads, setReads] = React.useState<Readonly<{ key: string; reads: readonly ReviewRunRead[] }>>({ key: '', reads: NO_READS });
    React.useEffect(() => {
        if (!scope || runIds.length === 0) return;
        let current = true;
        let loading = false;
        let refreshPending = false;
        const load = async () => {
            if (loading) { refreshPending = true; return; }
            loading = true;
            setReads((previous) => previous.key === readKey ? previous : ({
                key: readKey,
                reads: runIds.map((runId) => ({ runId, run: null, payload: null, state: 'loading' })),
            }));
            const next = await Promise.all(runIds.map(async (runId): Promise<ReviewRunRead> => {
                const got = await sessionExecutionRunGet(sessionId, { runId, includeStructured: true }, { serverId: scope.serverId, scope })
                    .catch(() => null);
                const payload = got && 'run' in got ? readReviewPayload(got.structuredMeta) : null;
                return got && 'run' in got
                    ? { runId, run: got.run, payload, state: payload ? 'readable' : 'unread' }
                    : { runId, run: null, payload: null, state: 'failed' };
            }));
            if (current) setReads((previous) => ({ key: readKey, reads: next.map((read) => {
                const last = previous.key === readKey ? previous.reads.find((entry) => entry.runId === read.runId) : null;
                return read.state === 'readable' ? read : { ...read, run: read.run ?? last?.run ?? null, payload: last?.payload ?? null };
            }) }));
            loading = false;
            if (current && refreshPending) { refreshPending = false; await load(); }
        };
        fireAndForget(load(), { tag: 'useWalkthroughReview.load' });
        const unsubscribe = subscribeExecutionRunActivity({ serverId: scope.serverId, sessionId }, (notification) => {
            if (notification.runId !== null && !runIds.includes(notification.runId)) return;
            fireAndForget(load(), { tag: 'useWalkthroughReview.refresh' });
        });
        return () => { current = false; unsubscribe(); };
    }, [runIds, readKey, scope, sessionId]);
    const runReads = reads.key === readKey ? reads.reads : NO_READS;

    const commentIdsByRunId = React.useMemo(() => Object.fromEntries(runReads.map((read) => [
        read.runId, (read.payload?.findings ?? []).flatMap((finding) => finding.comment ? [finding.comment.id] : []),
    ])), [runReads]);
    const comments = useReviewRunsComments({ scope, sessionId, runIds, commentIdsByRunId, enabled: runIds.length > 0 });
    const { messages } = useSessionMessages(sessionId, { enabled: runIds.length > 0 });

    return React.useMemo(() => {
        if (!comparison || runIds.length === 0) return null;
        const producerRuns = producer?.kind === 'review' ? producer.reviewedRuns ?? [] : [];
        const reviewerLabelByRunId: Record<string, string> = {};
        const readStateByRunId: Record<string, ReviewRunRead['state']> = {};
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
            const findings = payload ? resolveEffectiveReviewFindings({ runRef, initialFindings: payload.findings, messages }).findings : [];
            const snapshot = comments[runIds.indexOf(runId)];
            const anchorsByFindingId: Record<string, ReviewCommentAnchorV1> = {};
            for (const comment of snapshot?.comments ?? []) {
                if (comment.findingId) anchorsByFindingId[comment.findingId] = comment.anchor;
            }
            const status = read?.run?.status ?? recorded?.status;
            return {
                runRef,
                comparisonId: (payload && 'comparisonId' in payload && typeof payload.comparisonId === 'string' ? payload.comparisonId : undefined) ?? recorded?.comparisonId,
                findings,
                ...(status ? { status: status as ReviewFindingsOverlayReview['status'] } : {}),
                hasOutput: payload !== null,
                ...(payload && 'limits' in payload && payload.limits?.findingsTruncated ? { findingsTruncated: true } : {}),
                ...(readState !== 'readable' ? { reviewOutcome: 'partial' as const }
                    : readReviewOutcome(payload) ? { reviewOutcome: readReviewOutcome(payload)! } : {}),
                anchorsByFindingId,
            };
        });
        const overlay = buildWalkthroughReviewOverlay({
            overlay: projectReviewFindingsOverlay({ comparison, walkthrough: walkthrough?.value ?? null, reviews }),
            stops: walkthrough?.value?.stops ?? [],
            reviewerLabelByRunId,
        });
        const narrationMode = producer?.kind === 'review' ? producer.narrationMode ?? null : null;
        const producerRunId = producer?.kind === 'review' ? producer.runId ?? null : null;
        const findingsOnlyReviewer = runIds.length === 1 && narrationMode !== 'seeded_narrator'
            && producerRunId !== null && producerRunId !== runIds[0];
        const finishedAt = runReads.map((read) => read.run?.finishedAtMs ?? 0).reduce((max, at) => Math.max(max, at), 0);
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
        };
    }, [comments, comparison, messages, producer, runIds, runReads, walkthrough]);
}
