export type StepTransitionDirection = 'forward' | 'backward' | 'replace';

export type ResolveStepTransitionDirectionParams = Readonly<{
    previousIndex: number | null;
    nextIndex: number;
}>;

/**
 * Pure helper. Resolve the transition direction from a previous→next index pair.
 * Used by StoryDeck (page deltas) and wizard surfaces (step index deltas).
 */
export function resolveStepTransitionDirection(params: ResolveStepTransitionDirectionParams): StepTransitionDirection {
    if (params.previousIndex == null) {
        return 'replace';
    }
    if (params.nextIndex > params.previousIndex) {
        return 'forward';
    }
    if (params.nextIndex < params.previousIndex) {
        return 'backward';
    }
    return 'replace';
}
