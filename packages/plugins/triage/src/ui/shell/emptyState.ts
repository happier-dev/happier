import type { TriageListShellStateV1 } from './windowState.js';

/**
 * What an empty PRs & Issues list is allowed to say.
 *
 * "Every configured source answered" is a claim about coverage, and the shell
 * used to make it unconditionally — under a partial-coverage banner, and under a
 * banner saying a source had just failed. A reader who is told nothing needs
 * them stops looking, so an empty list that cannot prove completeness must say
 * which kind of empty it is instead.
 *
 * The four kinds are exactly the four the window can actually be in, and they
 * are decided from independent facts the store already keeps apart: whether a
 * source failed, whether the walk finished, and whether anything is configured
 * at all. Precedence runs from the least trustworthy fact to the most: a
 * failure outranks incompleteness, and incompleteness outranks the healthy
 * claim, because each one falsifies the claim below it.
 */
export type TriageListEmptyStateV1 = Readonly<{
    /**
     * `failure` is rendered as an error with a retry; the rest are ordinary
     * empty states, because nothing went wrong in them.
     */
    kind: 'sourceFailure' | 'boundedWindow' | 'reading' | 'healthy';
    title: string;
    description: string;
}>;

const HEALTHY: TriageListEmptyStateV1 = Object.freeze({
    kind: 'healthy',
    title: 'Nothing needs you',
    description: 'Every configured source answered, and none of them has an entry for you right now.',
});

const READING: TriageListEmptyStateV1 = Object.freeze({
    kind: 'reading',
    title: 'Still reading your sources',
    description: 'Nothing has come back yet. This list fills in as each source answers.',
});

const BOUNDED: TriageListEmptyStateV1 = Object.freeze({
    kind: 'boundedWindow',
    title: 'This list is not complete yet',
    description: 'Some sources had not finished their walk, so entries may still be missing. Refresh to keep reading.',
});

/**
 * The empty slot of an assembled window.
 *
 * It is only ever reached with zero rows: a retained row is shown beside a
 * failure rather than replaced by it, which is the window owner's decision, not
 * this one's.
 */
export function resolveTriageListEmptyState(input: Readonly<{
    coverage: 'complete' | 'partial';
    /** A retained source failure, in the store's own words. `null` is no failure. */
    error: string | null;
    /** A pass is in flight over this empty window. */
    refreshing: boolean;
}>): TriageListEmptyStateV1 {
    if (input.error !== null) {
        return Object.freeze({
            kind: 'sourceFailure',
            title: 'Some sources could not be read',
            // The store's message is the only honest description here: this
            // resolver has no idea which source failed or why, and inventing a
            // generic sentence would hide the one fact the reader can act on.
            description: input.error,
        });
    }
    if (input.coverage === 'partial') return input.refreshing ? READING : BOUNDED;
    // A complete window with a refresh in flight is a real, current, empty
    // answer; the pass now running may change it, but nothing said so far is
    // untrue.
    return HEALTHY;
}

/** The empty slot for one resolved shell state, or `null` when rows are shown. */
export function readTriageListEmptyState(
    state: TriageListShellStateV1,
    rowCount: number,
): TriageListEmptyStateV1 | null {
    if (state.kind !== 'window' || rowCount > 0) return null;
    return resolveTriageListEmptyState({
        coverage: state.window.coverage,
        error: state.error,
        refreshing: state.refreshing,
    });
}
