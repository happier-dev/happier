import { describe, expect, it } from 'vitest';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageLensNarrowingV1 } from '../state/narrowing.js';
import { readTriageLensNarrowingV1 } from '../state/narrowing.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import {
    readTriageListEmptyBelowPinsV1,
    readTriageListEmptyState,
    readTriageListEmptyStateKeys,
    resolveTriageListEmptyState,
} from './emptyState.js';
import type { TriageListShellFailureV1, TriageListShellStateV1 } from './windowState.js';

const NOT_NARROWED: TriageLensNarrowingV1 = { facets: false, search: false, narrowed: false };
const FACET_NARROWED: TriageLensNarrowingV1 = { facets: true, search: false, narrowed: true };
const SEARCH_NARROWED: TriageLensNarrowingV1 = { facets: false, search: true, narrowed: true };

/** One named connection that could not be read, as the shell state carries it. */
const BROKEN_SOURCE: TriageListShellFailureV1 = {
    kind: 'sources',
    sources: [{
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        displayName: 'example-forge',
        reason: 'Could not be reached just now.',
    }],
};

function windowState(input: Readonly<{
    coverage: 'complete' | 'partial';
    failure?: TriageListShellFailureV1 | null;
    refreshing?: boolean;
    rows?: TriageListWindowV1['rows'];
}>): TriageListShellStateV1 {
    return {
        kind: 'window',
        window: {
            v: 1,
            rows: input.rows ?? [],
            lanes: [],
            coverage: input.coverage,
            assembledAtMs: 0,
        },
        refreshing: input.refreshing ?? false,
        stale: false,
        failure: input.failure ?? null,
    };
}

describe('the empty PRs & Issues list', () => {
    it('keeps an empty Tasks lens distinct from all-clear and offers only real continuations', () => {
        const narrowing = readTriageLensNarrowingV1({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'mine' }, query: '' });
        expect(resolveTriageListEmptyState({ coverage: 'complete', failure: null, refreshing: false, narrowing }))
            .toMatchObject({ kind: 'noTasks', next: [] });
        expect(resolveTriageListEmptyState({ coverage: 'partial', failure: null, refreshing: false, narrowing }))
            .toMatchObject({ kind: 'noTasksYet', next: ['loadMore'] });
    });
    it('claims every source answered only when a complete window really is empty', () => {
        expect(resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: NOT_NARROWED,
        }))
            .toMatchObject({ kind: 'healthy', description: expect.stringContaining('Every configured source answered') });
    });

    it('never claims every source answered while a filter is narrowing the window', () => {
        const complete = resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: FACET_NARROWED,
        });

        // "None of them has an entry for you right now" is false the moment a
        // facet is selected: the sources answered and the reader's own filter is
        // what removed the rows. Saying it anyway is how a reader concludes
        // nothing needs them and stops looking.
        expect(complete.kind).toBe('noMatch');
        expect(complete.title).not.toBe(resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: NOT_NARROWED,
        }).title);

        const partial = resolveTriageListEmptyState({
            coverage: 'partial',
            failure: null,
            refreshing: false,
            narrowing: FACET_NARROWED,
        });

        // At partial coverage the honest claim is narrower still: no match YET,
        // because the walk has not finished the set the filter is being applied
        // to (`core/SURFACE.md` §6.2).
        expect(partial.kind).toBe('noMatchYet');
        expect(partial.title).not.toEqual(complete.title);
    });

    it('names the reader own search rather than a filter they never set', () => {
        // Four causes, four sentences (`core/SURFACE.md` §6.2). A query that
        // matches nothing and a facet that matches nothing are two of them: the
        // way out of the first is the search box and the way out of the second
        // is the rail, and a reader sent to "adjust or clear a filter" while no
        // facet is selected is looking at controls with nothing on them.
        const complete = resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: SEARCH_NARROWED,
        });
        expect(complete.kind).toBe('noSearchMatch');
        expect(`${complete.title} ${complete.description}`).not.toMatch(/filter/iu);
        expect(complete.title).not.toEqual(resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: FACET_NARROWED,
        }).title);

        const partial = resolveTriageListEmptyState({
            coverage: 'partial',
            failure: null,
            refreshing: false,
            narrowing: SEARCH_NARROWED,
        });
        expect(partial.kind).toBe('noSearchMatchYet');
        expect(`${partial.title} ${partial.description}`).not.toMatch(/filter/iu);

        // A facet selected beside the query keeps the filter sentence: the rail
        // does have something on it, and **Clear filters** is what clears it.
        expect(resolveTriageListEmptyState({
            coverage: 'complete',
            failure: null,
            refreshing: false,
            narrowing: { facets: true, search: true, narrowed: true },
        }).kind).toBe('noMatch');
    });

    it('offers each narrowed empty list the way out that matches what narrowed it', () => {
        // A narrowed empty list never leaves the reader at a sentence: a search that
        // matched nothing is cleared from the search box, a facet from the rail, and
        // a window that has not finished reading can also be read further. The steps
        // are decided here, beside the sentence they belong to, so the copy and the
        // control cannot name different ways out.
        const next = (coverage: 'complete' | 'partial', narrowing: TriageLensNarrowingV1) =>
            resolveTriageListEmptyState({ coverage, failure: null, refreshing: false, narrowing }).next;

        expect(next('complete', SEARCH_NARROWED)).toEqual(['clearSearch']);
        expect(next('partial', SEARCH_NARROWED)).toEqual(['loadMore', 'clearSearch']);
        expect(next('complete', FACET_NARROWED)).toEqual(['clearFilters']);
        expect(next('partial', FACET_NARROWED)).toEqual(['loadMore', 'clearFilters']);
        // Nothing the reader narrowed, nothing to undo: the healthy, reading and bounded
        // states have their own header controls.
        expect(next('complete', NOT_NARROWED)).toEqual([]);
        expect(next('partial', NOT_NARROWED)).toEqual([]);
    });

    it('gives every empty kind its own catalog keys', () => {
        // A kind with no keys renders its English fallback on every locale and
        // nothing fails, so the map is asserted over the kinds themselves.
        for (const kind of ['healthy', 'reading', 'boundedWindow', 'noMatch', 'noMatchYet', 'noSearchMatch', 'noSearchMatchYet'] as const) {
            const keys = readTriageListEmptyStateKeys(kind);
            expect(keys.title.length, kind).toBeGreaterThan(0);
            expect(keys.description.length, kind).toBeGreaterThan(0);
        }
    });

    it('never claims every source answered while a source is reporting a failure', () => {
        const resolved = resolveTriageListEmptyState({
            coverage: 'complete',
            failure: BROKEN_SOURCE,
            refreshing: false,
            narrowing: NOT_NARROWED,
        });

        expect(resolved.kind).toBe('sourceFailure');
        // The reader is told *which* connection failed and why, from the one
        // failure notice the banner beside a non-empty list also renders.
        expect(resolved).toMatchObject({
            title: 'example-forge could not be read',
            description: 'Could not be reached just now.',
        });
        expect(`${resolved.title} ${resolved.description}`).not.toMatch(/answered/u);
    });

    it('never claims every source answered while the walk is still bounded', () => {
        const resolved = resolveTriageListEmptyState({
            coverage: 'partial',
            failure: null,
            refreshing: false,
            narrowing: NOT_NARROWED,
        });

        expect(resolved.kind).toBe('boundedWindow');
        expect(`${resolved.title} ${resolved.description}`).not.toMatch(/answered/u);
    });

    it('says a pass is still running rather than that the walk stopped short', () => {
        expect(resolveTriageListEmptyState({
            coverage: 'partial',
            failure: null,
            refreshing: true,
            narrowing: NOT_NARROWED,
        })).toMatchObject({ kind: 'reading' });
    });

    it('ranks a failure above incompleteness and above the reader own filter', () => {
        expect(resolveTriageListEmptyState({
            coverage: 'partial',
            failure: BROKEN_SOURCE,
            refreshing: true,
            narrowing: NOT_NARROWED,
        }).kind).toBe('sourceFailure');
        // A broken connection outranks "no match": the reader must not conclude
        // their filter matched nothing while a whole source went unread.
        expect(resolveTriageListEmptyState({
            coverage: 'complete',
            failure: BROKEN_SOURCE,
            refreshing: false,
            narrowing: FACET_NARROWED,
        }).kind).toBe('sourceFailure');
    });

    it('is reached only by an assembled window that has no rows to show', () => {
        // The unavailable and unconfigured states are their own screens; a list
        // empty slot must never speak for them.
        const lens = { narrowing: NOT_NARROWED };
        expect(readTriageListEmptyState({ kind: 'initial' }, 0, lens)).toBeNull();
        expect(readTriageListEmptyState({ kind: 'configureSources' }, 0, lens)).toBeNull();
        expect(readTriageListEmptyState({ kind: 'unavailable', message: 'no' }, 0, lens)).toBeNull();
        expect(readTriageListEmptyState(windowState({ coverage: 'complete' }), 3, lens)).toBeNull();
        expect(readTriageListEmptyState(windowState({ coverage: 'partial' }), 0, lens))
            .toMatchObject({ kind: 'boundedWindow' });
    });

    it('carries the shell own filter fact into the empty slot', () => {
        expect(readTriageListEmptyState(windowState({ coverage: 'complete' }), 0, { narrowing: FACET_NARROWED }))
            .toMatchObject({ kind: 'noMatch' });
        // `healthy` must be EARNED by an explicit not-narrowed lens, never
        // reached by omitting one: a caller that forgets would otherwise have a
        // filtered result announced as a healthy empty account.
        expect(readTriageListEmptyState(windowState({ coverage: 'complete' }), 0, { narrowing: NOT_NARROWED }))
            .toMatchObject({ kind: 'healthy' });
    });
});

describe('readTriageListEmptyBelowPinsV1', () => {
    const below = (state: TriageListShellStateV1, unpinned: number, pinned: number, narrowing: TriageLensNarrowingV1) =>
        readTriageListEmptyBelowPinsV1(state, { pinned, unpinned }, { narrowing });

    it('answers a filter that left only pins, so it never ends in a blank canvas', () => {
        expect(below(windowState({ coverage: 'complete' }), 0, 2, FACET_NARROWED)?.kind).toBe('noMatch');
        expect(below(windowState({ coverage: 'complete' }), 0, 2, SEARCH_NARROWED)?.kind).toBe('noSearchMatch');
        expect(below(windowState({ coverage: 'partial' }), 0, 2, FACET_NARROWED)?.kind).toBe('noMatchYet');
    });

    it('names unreadable sources below pins rather than inventing more pages after exhaustion', () => {
        const answer = below(windowState({ coverage: 'complete', failure: BROKEN_SOURCE }), 0, 2, FACET_NARROWED);
        expect(answer?.kind).toBe('sourceFailure');
        expect(`${answer?.title} ${answer?.description}`).toContain('example-forge');
        expect(answer?.next).not.toContain('loadMore');
    });

    it('stays out of a list with rows, an unnarrowed list, and a list with no pins', () => {
        expect(below(windowState({ coverage: 'complete' }), 3, 2, FACET_NARROWED)).toBeNull();
        expect(below(windowState({ coverage: 'complete' }), 0, 2, NOT_NARROWED)).toBeNull();
        expect(below(windowState({ coverage: 'complete' }), 0, 0, FACET_NARROWED)).toBeNull();
    });
});
