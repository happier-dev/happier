import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { SelectActionInputRequest, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
    TriageStartPullRequestReviewResultV1Schema,
    type TriagePullRequestReviewChoiceV1,
    type TriageStartPullRequestReviewResultV1,
} from '../actions/entrySessionProtocol.js';
import type { TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';

export type TriagePullRequestReviewContinuationHostV1 = Readonly<{
    executeAction(action: string, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown>;
    selectActionInput(request: SelectActionInputRequest, options?: PluginCancellationOptions): Promise<SelectActionInputResult>;
}>;
export type TriagePullRequestReviewContinuationOutcomeV1 =
    | Readonly<{ kind: 'cancelled' | 'unavailable' | 'unknown' }>
    | Readonly<{ kind: 'settled'; result: TriageStartPullRequestReviewResultV1 }>;

/** One launch-selection and engine-start sequence for mounted and configured Review. */
export async function continueTriagePullRequestReviewV1(
    host: TriagePullRequestReviewContinuationHostV1,
    pending: TriagePendingPullRequestReviewV1,
    choice: TriagePullRequestReviewChoiceV1,
    options?: PluginCancellationOptions & Readonly<{ isCurrent?: () => boolean }>,
): Promise<TriagePullRequestReviewContinuationOutcomeV1> {
    const current = () => options?.signal?.aborted !== true && options?.isCurrent?.() !== false;
    const cancellation = options?.signal === undefined ? undefined : { signal: options.signal };
    if (!current()) return { kind: 'cancelled' };
    let launchSelection = choice.launchSelection;
    if (launchSelection === undefined) {
        try {
            const selected = await host.selectActionInput({
                hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
                sessionId: pending.sessionId, serverId: pending.review.workspace.serverId,
                draft: { engineIds: [...choice.engineIds], instructions: pending.instructions },
            }, cancellation);
            if (!current() || selected.kind === 'cancelled') return { kind: 'cancelled' };
            if (selected.kind !== 'executionRunLaunch') return { kind: 'unavailable' };
            launchSelection = selected.input;
        } catch { return { kind: current() ? 'unavailable' : 'cancelled' }; }
    }
    if (!current()) return { kind: 'cancelled' };
    let raw: unknown;
    try {
        raw = await host.executeAction(TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1, {
            v: 1, sessionId: pending.sessionId, review: pending.review,
            instructions: pending.instructions, ...choice, launchSelection,
            ...(choice.comparisonSource === undefined && pending.comparisonSource !== undefined
                ? { comparisonSource: pending.comparisonSource } : {}),
        } as unknown as JsonValue, cancellation);
    } catch { return { kind: 'unknown' }; }
    const parsed = TriageStartPullRequestReviewResultV1Schema.safeParse(raw);
    return parsed.success ? { kind: 'settled', result: parsed.data } : { kind: 'unavailable' };
}
