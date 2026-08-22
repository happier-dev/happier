import type { TriageLensNarrowingV1 } from '../state/narrowing.js';
import {
    readTriageListFailureNotice,
    type TriageListShellFailureV1,
    type TriageListShellStateV1,
    type TriageTextResolverV1,
} from './windowState.js';

const ENGLISH_TEXT: TriageTextResolverV1 = (_key, fallback = '') => fallback;

/** A lens hiding nothing, for the callers that have no lens to report. */
/**
 * What an empty PRs & Issues list is allowed to say.
 *
 * "Every configured source answered" is a claim about coverage, and the shell
 * used to make it unconditionally — under a partial-coverage banner, and under a
 * banner saying a source had just failed. A reader who is told nothing needs
 * them stops looking, so an empty list that cannot prove completeness must say
 * which kind of empty it is instead.
 *
 * The kinds are exactly the ones the window can actually be in, and they are
 * decided from independent facts the store and the reducer already keep apart:
 * whether a source failed, whether the walk finished, whether the reader's own
 * lens is narrowing the result, and whether anything is configured at all.
 * Precedence runs from the least trustworthy fact to the most: a failure
 * outranks incompleteness and the reader's filter, and incompleteness narrows
 * what a filtered result may claim, because each one falsifies the claim below
 * it.
 *
 * **A narrowed window may not take the healthy treatment at all**
 * (`core/SURFACE.md` §6.2). "Every configured source answered, and none of them
 * has an entry for you" is false while a facet or a query is selected: the
 * sources answered and the reader's own lens removed the rows, and the only
 * honest next action is to adjust that lens rather than to stop looking.
 */
export type TriageListEmptyStateV1 = Readonly<{
    /**
     * `failure` is rendered as an error with a retry; the rest are ordinary
     * empty states, because nothing went wrong in them.
     */
    kind:
        | 'sourceFailure'
        | 'boundedWindow'
        | 'reading'
        | 'noMatch'
        | 'noMatchYet'
        | 'noSearchMatch'
        | 'noSearchMatchYet'
        | 'healthy';
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

const NO_MATCH: TriageListEmptyStateV1 = Object.freeze({
    kind: 'noMatch',
    title: 'Nothing matches these filters',
    description: 'Every configured source answered, and nothing in this list matches what you selected. Adjust or clear a filter to widen it.',
});

const NO_MATCH_YET: TriageListEmptyStateV1 = Object.freeze({
    kind: 'noMatchYet',
    title: 'No match yet',
    description: 'Nothing matches these filters in the part of your sources read so far. Keep reading, or clear a filter to widen it.',
});

const NO_SEARCH_MATCH: TriageListEmptyStateV1 = Object.freeze({
    kind: 'noSearchMatch',
    title: 'Nothing matches your search',
    description: 'Every configured source answered, and nothing in this list matches what you typed. Clear the search to widen it.',
});

const NO_SEARCH_MATCH_YET: TriageListEmptyStateV1 = Object.freeze({
    kind: 'noSearchMatchYet',
    title: 'No search match yet',
    description: 'Nothing matches what you typed in the part of your sources read so far. Keep reading, or clear the search to widen it.',
});

const EMPTY_TRANSLATION_KEYS_V1: Readonly<Record<TriageListEmptyStateV1['kind'], Readonly<{
    title: string;
    description: string;
}>>> = Object.freeze({
    sourceFailure: Object.freeze({ title: '', description: '' }),
    healthy: Object.freeze({
        title: 'plugins.triage.surface.empty.healthy.title',
        description: 'plugins.triage.surface.empty.healthy.description',
    }),
    reading: Object.freeze({
        title: 'plugins.triage.surface.empty.reading.title',
        description: 'plugins.triage.surface.empty.reading.description',
    }),
    boundedWindow: Object.freeze({
        title: 'plugins.triage.surface.empty.incomplete.title',
        description: 'plugins.triage.surface.empty.incomplete.description',
    }),
    noMatch: Object.freeze({
        title: 'plugins.triage.surface.empty.noMatch.title',
        description: 'plugins.triage.surface.empty.noMatch.description',
    }),
    noMatchYet: Object.freeze({
        title: 'plugins.triage.surface.empty.noMatchYet.title',
        description: 'plugins.triage.surface.empty.noMatchYet.description',
    }),
    noSearchMatch: Object.freeze({
        title: 'plugins.triage.surface.empty.noSearchMatch.title',
        description: 'plugins.triage.surface.empty.noSearchMatch.description',
    }),
    noSearchMatchYet: Object.freeze({
        title: 'plugins.triage.surface.empty.noSearchMatchYet.title',
        description: 'plugins.triage.surface.empty.noSearchMatchYet.description',
    }),
});

/**
 * The catalog keys for one resolved empty state.
 *
 * They live beside the copy rather than in the shell's JSX so the two cannot
 * drift: a fifth kind with no key would otherwise render its English fallback
 * on every locale, and nothing would fail.
 */
/**
 * Every empty slot that carries copy of its own.
 *
 * Derived from the key table rather than listed, so a kind added later cannot go
 * unguarded: TypeScript already forces a new kind into `EMPTY_TRANSLATION_KEYS_V1`,
 * and this derivation carries it into the i18n parity check on its own. A
 * hand-written list could not — a kind missing from EVERY locale would be absent
 * from the list too, and a check comparing locales against each other would call
 * that agreement.
 *
 * `sourceFailure` falls out because it holds no keys: it renders the failure
 * notice's own copy so the two cannot name different connections. That is read
 * from the table rather than excluded by name, so the reason survives a rename.
 */
export const TRANSLATED_TRIAGE_EMPTY_KINDS_V1: readonly TriageListEmptyStateV1['kind'][] =
    Object.freeze((Object.keys(EMPTY_TRANSLATION_KEYS_V1) as TriageListEmptyStateV1['kind'][])
        .filter((kind) => EMPTY_TRANSLATION_KEYS_V1[kind].title !== ''));

export function readTriageListEmptyStateKeys(
    kind: TriageListEmptyStateV1['kind'],
): Readonly<{ title: string; description: string }> {
    return EMPTY_TRANSLATION_KEYS_V1[kind];
}

/**
 * The empty slot of an assembled window.
 *
 * It is only ever reached with zero rows: a retained row is shown beside a
 * failure rather than replaced by it, which is the window owner's decision, not
 * this one's.
 */
export function resolveTriageListEmptyState(input: Readonly<{
    coverage: 'complete' | 'partial';
    /** A retained failure and whose it is. `null` is no failure. */
    failure: TriageListShellFailureV1 | null;
    /** A pass is in flight over this empty window. */
    refreshing: boolean;
    /**
     * Which halves of the reader's own lens are narrowing this window, read
     * from the one narrowing owner (`ui/state/narrowing.ts`).
     *
     * It is required rather than defaulted because an omitted value would claim
     * the healthy state for a filtered result, which is the exact falsehood
     * `core/SURFACE.md` §6.2 forbids. The two causes arrive apart rather than
     * pre-collapsed into one boolean because the sentence differs: a query that
     * matches nothing is cleared from the search box, and a facet that matches
     * nothing is cleared from the rail.
     */
    narrowing: TriageLensNarrowingV1;
}>, text: TriageTextResolverV1 = ENGLISH_TEXT): TriageListEmptyStateV1 {
    if (input.failure !== null) {
        // The one failure notice, so the empty slot and the banner beside a
        // non-empty list cannot end up naming different things.
        return Object.freeze({
            kind: 'sourceFailure',
            ...readTriageListFailureNotice(input.failure, text),
        });
    }
    if (input.narrowing.facets) {
        // The rail stays visible beside this, so the named next action —
        // adjust or clear a filter — is already on screen. A query narrowing
        // beside a facet still takes this sentence: **Clear filters** is what
        // clears the half the reader cannot see at a glance, and the query is
        // already sitting in the search box above.
        return input.coverage === 'partial' ? NO_MATCH_YET : NO_MATCH;
    }
    if (input.narrowing.search) {
        // The other half of §6.2's four causes. With no facet selected, "adjust
        // or clear a filter" points at a rail with nothing on it, so the
        // sentence names the search box the query is actually in.
        return input.coverage === 'partial' ? NO_SEARCH_MATCH_YET : NO_SEARCH_MATCH;
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
    options: Readonly<{ narrowing: TriageLensNarrowingV1; text?: TriageTextResolverV1 }>,
): TriageListEmptyStateV1 | null {
    if (state.kind !== 'window' || rowCount > 0) return null;
    return resolveTriageListEmptyState({
        coverage: state.window.coverage,
        failure: state.failure,
        refreshing: state.refreshing,
        narrowing: options.narrowing,
    }, options.text ?? ENGLISH_TEXT);
}
