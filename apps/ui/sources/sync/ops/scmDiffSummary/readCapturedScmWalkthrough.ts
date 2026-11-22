import type { ReviewRoundComparisonCaptureV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm/diffSummary';

import { scmReviewComparisonMatchesSource, selectScmWalkthroughKey } from '@/sync/domains/scm/diffSummary/selection';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getScmDiffSummaryOperationState, getScmDiffSummaryState, loadSavedScmDiffSummaryResult } from './generate';
import { createScmDiffSummaryResultOperations } from './results';
import { createScmDiffSummarySavedResultOperations } from './savedResultOperations';

/** Restore the existing saved reading for an exact captured round, without generating another one. */
export async function readCapturedScmWalkthrough(
    capture: ReviewRoundComparisonCaptureV1,
    lifetime: ServerAccountScopeLifetime,
    signal?: AbortSignal,
): Promise<ScmDiffSummaryWalkthrough | undefined> {
    const { scope } = lifetime;
    const { machineId } = capture.target;
    const { source, comparisonId, cwd, sessionId } = capture.input;
    const shouldContinue = () => lifetime.isCurrent() && !signal?.aborted;
    if (!shouldContinue()) return undefined;

    const host = sessionId ? { sessionId } : { machineId, cwd };
    const state = getScmDiffSummaryState();
    const key = selectScmWalkthroughKey(state, host, { ...source, comparisonId }, 'walkthrough', serverAccountScopeKeySuffix(scope));
    const known = key ? getScmDiffSummaryOperationState(state, key, 'walkthrough') : null;
    const published = known?.outputs?.walkthrough?.value;
    if (published) return published;

    // Only a currently established Session adapter may authorize a Session inventory read.
    if (sessionId && readMachineControlTargetForSession({ ...scope, sessionId })?.machineId !== machineId) return undefined;
    const options = { ...scope, signal, shouldContinue };
    const inventory = createScmDiffSummarySavedResultOperations({ ...options, machineId, ...(sessionId ? { sessionId } : {}) });
    const listed = await inventory.list({ query: { cwd, sessionId: sessionId ?? null,
        comparisons: [{ source, comparisonId, outputs: ['walkthrough'] }] } });
    if (!listed.success || !shouldContinue()) return undefined;

    const operation = createScmDiffSummaryResultOperations({ ...(sessionId ? { sessionId } : { machineId }), ...options });
    for (const candidate of listed.results) {
        if (candidate.cwd !== cwd || (candidate.sessionId ?? null) !== (sessionId ?? null)
            || candidate.comparisonId !== comparisonId || !scmReviewComparisonMatchesSource(source, candidate.source)) continue;
        const response = await operation.read({ cwd, resultId: candidate.resultId });
        if (!shouldContinue()) return undefined;
        if (!response.success) continue;
        const { result } = response;
        const captured = result.output.comparison;
        if (captured?.id !== comparisonId || captured.repository.rootPath !== cwd
            || !scmReviewComparisonMatchesSource(source, captured.source, captured)) continue;
        const output = result.output.outputs?.walkthrough?.value;
        if (!output) continue;
        loadSavedScmDiffSummaryResult({ ...host, scope, result, savedAtMs: candidate.updatedAtMs });
        return output;
    }
    return undefined;
}
