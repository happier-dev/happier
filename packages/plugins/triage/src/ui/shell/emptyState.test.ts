import { describe, expect, it } from 'vitest';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageLensNarrowingV1 } from '../state/narrowing.js';
import {
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
