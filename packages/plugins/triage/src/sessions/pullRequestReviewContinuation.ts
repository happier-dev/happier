import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { SelectActionInputRequest, SelectActionInputResult } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
    TriageStartPullRequestReviewResultV1Schema,
    type TriagePullRequestReviewChoiceV1,
    type TriageStartPullRequestReviewResultV1,
} from '../actions/entrySessionProtocol.js';
import type { TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import { projectTriageNewSessionFailureV1, type TriageNewSessionFailureV1 } from '../ui/header/newSessionSeedCommand.js';
import { resolveTriageConfiguredActionForExecutionV1 } from './actionResolution.js';

export type TriagePullRequestReviewContinuationHostV1 = Readonly<{
    executeAction(action: string, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown>;
    selectActionInput(request: SelectActionInputRequest, options?: PluginCancellationOptions): Promise<SelectActionInputResult>;
}>;
export type TriagePullRequestReviewContinuationOutcomeV1 =
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'unavailable' | 'unknown'; failure?: TriageNewSessionFailureV1 }>
    | Readonly<{ kind: 'settled'; result: TriageStartPullRequestReviewResultV1 }>;

export type TriagePreparedPullRequestReviewContinuationV1 =
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'unavailable'; failure?: TriageNewSessionFailureV1 }>
    | Readonly<{ kind: 'ready'; input: JsonValue }>;

/** Selection and current catalog resolution prepare one exact Review operand without starting it. */
export async function prepareTriagePullRequestReviewContinuationV1(
    host: TriagePullRequestReviewContinuationHostV1,
    pending: TriagePendingPullRequestReviewV1,
    choice: TriagePullRequestReviewChoiceV1,
    options?: PluginCancellationOptions & Readonly<{ isCurrent?: () => boolean }>,
): Promise<TriagePreparedPullRequestReviewContinuationV1> {
    const current = () => options?.signal?.aborted !== true && options?.isCurrent?.() !== false;
    const cancellation = options?.signal === undefined ? undefined : { signal: options.signal };
    if (!current()) return { kind: 'cancelled' };
    try {
        let launchSelection = choice.launchSelection;
        if (launchSelection === undefined) {
            const selected = await host.selectActionInput({
                hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
                sessionId: pending.sessionId, serverId: pending.review.workspace.serverId,
                draft: { engineIds: [...choice.engineIds], instructions: pending.instructions },
            }, cancellation);
            if (!current() || selected.kind === 'cancelled') return { kind: 'cancelled' };
            if (selected.kind !== 'executionRunLaunch') return { kind: 'unavailable' };
            launchSelection = selected.input;
        }
        if (!current()) return { kind: 'cancelled' };
        // Selection can remain open while the configured row changes elsewhere.
        const resolved = await resolveTriageConfiguredActionForExecutionV1(host, pending.actionId, 'pullRequest', cancellation);
        if (!current()) return { kind: 'cancelled' };
        if (resolved.status !== 'resolved' || resolved.action.target.kind !== 'reviewStart'
            || resolved.action.workspaceMode !== 'pull_request') return { kind: 'unavailable' };
        return { kind: 'ready', input: projectNativeJsonValueForTransport({
                v: 1, sessionId: pending.sessionId, review: pending.review,
                instructions: pending.instructions, ...choice, launchSelection,
                ...(choice.comparisonSource === undefined && pending.comparisonSource !== undefined
                    ? { comparisonSource: pending.comparisonSource } : {}),
            }) };
    } catch (error) {
        if (!current()) return { kind: 'cancelled' };
        const failure = projectTriageNewSessionFailureV1(error);
        return { kind: 'unavailable', ...(failure === undefined ? {} : { failure }) };
    }
}

export function settleTriagePullRequestReviewContinuationV1(raw: unknown): TriagePullRequestReviewContinuationOutcomeV1 {
    const parsed = TriageStartPullRequestReviewResultV1Schema.safeParse(raw);
    return parsed.success ? { kind: 'settled', result: parsed.data } : { kind: 'unavailable' };
}

/** Raw callers retain automation authority; the UI consumes preparation through its host control. */
export async function continueTriagePullRequestReviewV1(
    host: TriagePullRequestReviewContinuationHostV1,
    pending: TriagePendingPullRequestReviewV1,
    choice: TriagePullRequestReviewChoiceV1,
    options?: PluginCancellationOptions & Readonly<{ isCurrent?: () => boolean }>,
): Promise<TriagePullRequestReviewContinuationOutcomeV1> {
    const prepared = await prepareTriagePullRequestReviewContinuationV1(host, pending, choice, options);
    if (prepared.kind !== 'ready') return prepared;
    try {
        return settleTriagePullRequestReviewContinuationV1(await host.executeAction(
            TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1, prepared.input,
            options?.signal === undefined ? undefined : { signal: options.signal },
        ));
    } catch (error) {
        const failure = projectTriageNewSessionFailureV1(error);
        return { kind: 'unknown', ...(failure === undefined ? {} : { failure }) };
    }
}
