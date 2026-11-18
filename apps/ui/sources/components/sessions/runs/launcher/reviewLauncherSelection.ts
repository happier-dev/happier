import * as React from 'react';
import {
    ReviewEngineReviewerSelectionV1Schema,
    ReviewReviewerSelectionV1Schema,
    reviewReviewerIdForSelectionV1,
    type ReviewEngineReviewerSelectionV1,
    type ReviewReviewerSelectionV1,
    type ReviewStepV1,
} from '@happier-dev/protocol/reviews/reviewStart';

const configurationKeys = Object.keys(ReviewEngineReviewerSelectionV1Schema.shape)
    .filter(key => key !== 'kind' && key !== 'engineId');

/** Drafts may be incomplete; the Action schema still owns final admission. */
export function readReviewLauncherReviewers(input: Record<string, unknown>): ReviewReviewerSelectionV1[] {
    return Array.isArray(input.reviewers) ? input.reviewers.flatMap(value => {
        const parsed = ReviewReviewerSelectionV1Schema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    }) : [];
}

export function readReviewLauncherEngineIds(input: Record<string, unknown>): string[] {
    return readReviewLauncherReviewers(input).flatMap(reviewer => reviewer.kind === 'engine' ? [reviewer.engineId] : []);
}

export function selectReviewLauncherEngines(input: Record<string, unknown>, engineIds: readonly string[]): Record<string, unknown> {
    const reviewers = readReviewLauncherReviewers(input);
    const selected = new Set(engineIds);
    const kept = reviewers.filter(reviewer => reviewer.kind !== 'engine' || selected.has(reviewer.engineId));
    const existing = new Set(reviewers.flatMap(reviewer => reviewer.kind === 'engine' ? [reviewer.engineId] : []));
    return synchronizeReviewLauncherSteps({ ...input, reviewers: [...kept, ...engineIds.filter(engineId => !existing.has(engineId))
        .map(engineId => ({ kind: 'engine' as const, engineId }))] });
}

/** Native refusals address the original roster position, including repeated engine selections. */
export function selectReviewLauncherRetryReviewers(input: Record<string, unknown>, reviewerIds: readonly string[]): Record<string, unknown> {
    const selected = new Set(reviewerIds);
    return { ...input, reviewers: readReviewLauncherReviewers(input).filter((reviewer, index) =>
        reviewer.kind === 'engine' && selected.has(reviewReviewerIdForSelectionV1(index))) };
}

function soleEngine(input: Record<string, unknown>): ReviewEngineReviewerSelectionV1 | null {
    const engines = readReviewLauncherReviewers(input).filter(reviewer => reviewer.kind === 'engine');
    return engines.length === 1 ? engines[0]! : null;
}

/** Existing scalar controls edit the sole engine, while the stored roster retains every selection. */
export function reviewLauncherEngineConfiguration(input: Record<string, unknown>): Record<string, unknown> {
    const engine = soleEngine(input);
    if (!engine) return input;
    const { kind: _kind, engineId: _engineId, ...configuration } = engine;
    return { ...input, ...configuration };
}

export function updateReviewLauncherEngineConfiguration(
    input: Record<string, unknown>,
    update: React.SetStateAction<Record<string, unknown>>,
): Record<string, unknown> {
    const projected = reviewLauncherEngineConfiguration(input);
    const next = typeof update === 'function' ? update(projected) : update;
    if (next === projected) return input;
    const engine = soleEngine(input);
    if (!engine) return next;
    const reviewers = readReviewLauncherReviewers(next);
    const target = soleEngine(next) ?? engine;
    const updated = { ...next };
    const configuration: Record<string, unknown> = { ...target };
    for (const key of configurationKeys) {
        if (Object.is(projected[key], next[key])) continue;
        if (next[key] === undefined) delete configuration[key];
        else configuration[key] = next[key];
        delete updated[key];
    }
    // Unchanged projected values belong only to the engine that supplied them.
    for (const key of configurationKeys) {
        if (!Object.hasOwn(input, key)) delete updated[key];
    }
    updated.reviewers = reviewers.map(reviewer => reviewer.kind === 'engine' && reviewer.engineId === target.engineId
        ? configuration : reviewer);
    return synchronizeReviewLauncherSteps(updated);
}

export function useReviewLauncherEngineConfiguration(input: Record<string, unknown>,
    setInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>, enabled: boolean) {
    const actionInput = React.useMemo(() => enabled ? reviewLauncherEngineConfiguration(input) : input, [enabled, input]);
    const setActionInput = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>(update => {
        setInput(previous => enabled ? updateReviewLauncherEngineConfiguration(previous, update)
            : typeof update === 'function' ? update(previous) : update);
    }, [enabled, setInput]);
    return { actionInput, setActionInput };
}

/** Steps are authored by ReviewStartSteps; empty focus inherits the submitted request. */
export function readReviewLauncherSteps(input: Record<string, unknown>): readonly ReviewStepV1[] {
    return Array.isArray(input.steps) ? input.steps as ReviewStepV1[]
        : [{ kind: 'review', reviewers: readReviewLauncherReviewers(input), instructions: '' }];
}

export function compileReviewLauncherInput(input: Record<string, unknown>, instructions: string,
    sourceSession: Readonly<{ serverId: string; sessionId: string }> | null): Record<string, unknown> {
    const { steps: _steps, outputs, ...rest } = input;
    const steps = readReviewLauncherSteps(input).map(step => ({ ...step,
        instructions: step.instructions.trim() || instructions }));
    return { ...rest, ...(Array.isArray(outputs) && outputs.length > 0 ? { outputs } : {}), instructions: steps.length === 1 ? steps[0]!.instructions : instructions,
        reviewers: steps[0]?.reviewers ?? [],
        ...(steps.length > 1 ? { steps } : {}),
        ...(sourceSession && steps.some(step => step.reviewers.some(reviewer => reviewer.kind === 'engine'
            && reviewer.includeSessionTranscript)) ? { sourceSession } : {}),
    };
}

/** Scalar launch controls and the first step edit the same roster. */
function synchronizeReviewLauncherSteps(input: Record<string, unknown>): Record<string, unknown> {
    return Array.isArray(input.steps) ? { ...input, steps: readReviewLauncherSteps(input).map((step, index) => index === 0
        ? { ...step, reviewers: input.reviewers } : step) } : input;
}
