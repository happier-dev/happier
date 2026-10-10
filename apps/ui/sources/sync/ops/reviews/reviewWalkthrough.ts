import { ReviewEngineCapabilitiesSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { ReviewWalkthroughResponseSchema, type ReviewFindingIdentity } from '@happier-dev/protocol/reviews/reviewNarration';
import type { ActionExecuteResult } from '@happier-dev/protocol';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { captureScmComparisonForSession } from '@/sync/ops/scmDiffSummary/generate';
import { scmComparisonSourceOf, scmReviewComparisonOfCaptured, type ScmReviewComparisonSelector } from '@/sync/domains/scm/diffSummary/selection';
import {
    buildReviewStartWithWalkthroughInput,
    type ReviewWalkthroughEngine,
    type ReviewWalkthroughPlan,
} from '@/sync/domains/reviews/reviewWalkthroughPlan';

/**
 * The Session operations behind a review that explains itself (Walkthrough lab WT5): list the engines
 * that can review, start one review of a captured comparison, ask a finished review for its walkthrough,
 * and explicitly ask for an explanation of chosen findings. Each goes through the canonical Action front
 * door (`review.engines.list`, `review.start`, `review.walkthrough`, `review.explain_findings`), so UI,
 * voice and agents share one validation and permission path. Nothing here calls a model directly.
 */
type Failure = Readonly<{ ok: false; error: string; errorCode?: string }>;

function failure(result: unknown, fallback: string): Failure {
    const record = result && typeof result === 'object' ? result as { errorCode?: unknown } : {};
    return {
        ok: false,
        error: resolveActionExecutionFailureMessage(result as never, fallback) ?? fallback,
        ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    };
}

function executorFor(serverId: string | null) {
    return createDefaultActionExecutor({ resolveServerIdForSessionId: () => serverId });
}

/** The engines that can review this Session, with whether each can write prose. */
export async function listReviewWalkthroughEngines(params: Readonly<{ sessionId: string | null; machineId?: string; serverId: string | null }>): Promise<
    Readonly<{ ok: true; engines: readonly ReviewWalkthroughEngine[] }> | Failure
> {
    const result = await executorFor(params.serverId).execute(
        'review.engines.list',
        { sessionId: params.sessionId, ...(!params.sessionId && params.machineId ? { machineId: params.machineId } : {}) },
        { ...(params.sessionId ? { defaultSessionId: params.sessionId } : {}), ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(!params.sessionId && params.machineId ? { externalActionTarget: { kind: 'machine' as const, machineId: params.machineId },
                executionRunTargetMachineId: params.machineId } : {}) },
    );
    if (!result.ok) return failure(result, 'review_engines_unavailable');
    const items = (result.result as { items?: unknown })?.items;
    const engines = (Array.isArray(items) ? items : []).flatMap((item): ReviewWalkthroughEngine[] => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const engineId = typeof record.engineId === 'string' ? record.engineId : typeof record.value === 'string' ? record.value : null;
        if (!engineId) return [];
        // An engine that does not declare narration is findings-only; capability is never guessed.
        const capabilities = ReviewEngineCapabilitiesSchema.safeParse(record.capabilities);
        return [{
            engineId,
            label: typeof record.label === 'string' ? record.label : engineId,
            description: typeof record.description === 'string' ? record.description : null,
            enabled: record.enabled !== false,
            structuredNarration: capabilities.success && capabilities.data.structuredNarration,
        }];
    });
    return { ok: true, engines };
}

async function resolveComparisonId(params: Readonly<{
    sessionId: string | null;
    machineId?: string;
    serverId: string | null;
    cwd: string;
    comparison: ScmReviewComparisonSelector;
    comparisonId?: string | null;
}>): Promise<Readonly<{ ok: true; comparisonId: string }> | Failure> {
    const existing = params.comparisonId ?? params.comparison.comparisonId;
    if (existing) return { ok: true, comparisonId: existing };
    if (!params.sessionId && (!params.machineId || params.comparison.kind === 'session' || params.comparison.kind === 'turnCheckpoint')) {
        return { ok: false, error: 'review_comparison_unavailable', errorCode: 'review_comparison_unavailable' };
    }
    const captured = await captureScmComparisonForSession({
        ...(params.sessionId ? { sessionId: params.sessionId } : { machineId: params.machineId! }),
        serverId: params.serverId,
        input: { cwd: params.cwd, source: scmComparisonSourceOf(params.comparison, params.sessionId ?? '') },
    });
    if (!captured.success) return { ok: false, error: captured.error, ...(captured.errorCode ? { errorCode: captured.errorCode } : {}) };
    return { ok: true, comparisonId: captured.comparison.id };
}

export type ReviewOfComparisonStarted = Readonly<{
    ok: true;
    comparisonId: string;
    reviewRunIds: readonly string[];
    /** Engines whose review did not start; said out loud, not dropped. */
    notStartedEngineIds: readonly string[];
    /** The walkthrough could not be admitted although the review started; the findings still arrive. */
    narrationError: string | null;
}>;

/** One review of the exact comparison on screen; the comparison is captured first and named by its id. */
export async function startReviewOfComparison(params: Readonly<{
    sessionId: string | null;
    machineId?: string;
    serverId: string | null;
    cwd: string;
    comparison: ScmReviewComparisonSelector;
    comparisonId?: string | null;
    plan: ReviewWalkthroughPlan;
    instructions: string;
    launchInput?: Record<string, unknown>;
    /** The launcher owns exact-target admission, Session resume and Action dispatch. */
    start: (input: Record<string, unknown>) => Promise<ActionExecuteResult>;
}>): Promise<ReviewOfComparisonStarted | Failure> {
    const captured = await resolveComparisonId(params);
    if (!captured.ok) return captured;
    const result = await params.start({
        ...params.launchInput,
        ...buildReviewStartWithWalkthroughInput({
            sessionId: params.sessionId,
            plan: params.plan,
            instructions: params.instructions,
            comparisonId: captured.comparisonId,
            pending: params.comparison.kind === 'workingTree',
        }),
        ...(!params.sessionId ? { target: { kind: 'detached' }, machineId: params.machineId, cwd: params.cwd } : {}),
    });
    if (!result.ok) return failure(result, 'review_start_failed');
    const output = (result.result ?? {}) as {
        results?: readonly { key?: unknown; ok?: boolean; result?: { runId?: unknown } }[];
        narration?: { state?: unknown; error?: unknown } | null;
    };
    const reviewRunIds = (output.results ?? []).flatMap((item) => (item.ok === true && typeof item.result?.runId === 'string' ? [item.result.runId] : []));
    if (reviewRunIds.length === 0) return failure(result, 'review_start_failed');
    return {
        ok: true,
        comparisonId: captured.comparisonId,
        reviewRunIds,
        notStartedEngineIds: (output.results ?? []).flatMap((item) => (item.ok === true ? [] : [typeof item.key === 'string' ? item.key : ''])).filter(Boolean),
        narrationError: output.narration?.state === 'failed'
            ? (typeof output.narration.error === 'string' ? output.narration.error : 'review_narration_failed')
            : null,
    };
}

/**
 * "Walk me through this" on a finished review. The host decides whether the reviewer's own Run can
 * continue (no review again) or one narrator writes from the findings and the captured comparison.
 */
export async function requestFinishedReviewWalkthrough(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    cwd: string;
    runId: string;
    reviewRunIds: readonly string[];
    comparisonId: string | null;
    /** The comparison captured when the review carried none; pending changes, the default review scope. */
    fallbackComparison: ScmReviewComparisonSelector;
}>): Promise<Readonly<{ ok: true; comparisonId: string; comparison: ScmReviewComparisonSelector }> | Failure> {
    const captured = await resolveComparisonId({ ...params, comparison: params.fallbackComparison });
    if (!captured.ok) return captured;
    const result = await executorFor(params.serverId).execute(
        'review.walkthrough',
        { sessionId: params.sessionId, runId: params.runId, reviewRunIds: [...params.reviewRunIds], comparisonId: captured.comparisonId },
        { defaultSessionId: params.sessionId, ...(params.serverId ? { serverId: params.serverId } : {}) },
    );
    if (!result.ok) return failure(result, 'review_walkthrough_failed');
    const response = ReviewWalkthroughResponseSchema.safeParse(result.result);
    if (!response.success || response.data.comparisonId !== captured.comparisonId) {
        return { ok: false, error: 'review_comparison_unavailable', errorCode: 'review_comparison_unavailable' };
    }
    const comparison = scmReviewComparisonOfCaptured(response.data.comparison);
    if (!comparison) return { ok: false, error: 'review_comparison_unavailable', errorCode: 'review_comparison_unavailable' };
    return { ok: true, comparisonId: captured.comparisonId, comparison };
}

/** The explicit request: explain these findings in the walkthrough (a scoped refinement, never automatic). */
export async function requestExplainReviewFindings(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    cwd: string;
    runId: string;
    reviewRunIds: readonly string[];
    resultId: string;
    expectedRevision: number;
    findingIds: readonly ReviewFindingIdentity[];
}>): Promise<Readonly<{ ok: true }> | Failure> {
    const result = await executorFor(params.serverId).execute(
        'review.explain_findings',
        {
            sessionId: params.sessionId, runId: params.runId, reviewRunIds: [...params.reviewRunIds], cwd: params.cwd,
            resultId: params.resultId, expectedRevision: params.expectedRevision, findingIds: params.findingIds.map((id) => ({ ...id })),
        },
        { defaultSessionId: params.sessionId, ...(params.serverId ? { serverId: params.serverId } : {}) },
    );
    return result.ok ? { ok: true } : failure(result, 'review_explain_failed');
}
