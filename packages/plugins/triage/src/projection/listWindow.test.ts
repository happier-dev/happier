import { describe, expect, it } from 'vitest';

import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import {
    TRIAGE_TESTKIT_SOURCE,
    testkitEntryRef,
    testkitLocator,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    TRIAGE_LIST_DEFAULT_LENS_V1,
    TRIAGE_LIST_NO_FILTERS_V1,
    foldTriageListWindow,
    triageEntryRowKey,
    type SurfaceFilterSelectionV1,
    type TriageListLaneV1,
    type TriageListLensV1,
    type TriageListWindowV1,
} from './listWindow.js';

/**
 * The window assembler's own boundary.
 *
 * `foldTriageListWindow` is the single owner of the cross-connection fold, the
 * content winner, the lane, the filter conjunction, the order, the fair row
 * bound and the coverage claim. Every one of those decisions is silent when it
 * is wrong — a plausible row with the wrong title, a source that never appears,
 * an authoritative "nothing needs you" — so they are falsified here rather than
 * indirectly through a surface that would render either answer.
 */

const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.example.tracker', localId: 'example-issues' });

/** Ascending ids, so `INSTANCE[0]` is always the lexicographically smallest. */
const INSTANCE = Object.freeze([
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
]);

function present(input: Readonly<{
    sourceInstanceId: string;
    entryId?: string;
    observedAtMs?: number;
    title?: string;
    displayPath?: string;
    presentation?: 'active' | 'closed' | 'unknown';
    createdAtMs?: number;
    kindId?: string;
    collisionScope?: string;
    source?: typeof TRIAGE_TESTKIT_SOURCE;
    involvement?: readonly string[];
}>): CorpusQualifiedObservationV1 {
    return {
        entryRef: testkitEntryRef({
            entryId: input.entryId ?? '17',
            ...(input.kindId === undefined ? {} : { kindId: input.kindId }),
            ...(input.collisionScope === undefined ? {} : { collisionScope: input.collisionScope }),
            ...(input.source === undefined ? {} : { source: input.source }),
        }),
        sourceInstanceId: input.sourceInstanceId,
        observedAtMs: input.observedAtMs ?? 1_000,
        outcome: testkitPresentOutcome({
            locator: testkitLocator({
                ...(input.displayPath === undefined ? {} : { displayPath: input.displayPath }),
            }),
            snapshot: testkitSnapshot({
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
                state: {
                    presentation: input.presentation ?? 'active',
                    nativeLabel: input.presentation === 'closed' ? 'Closed' : 'Open',
                },
            }),
            viewer: testkitViewer({
                involvement: (input.involvement ?? []) as never,
            }),
        }),
    };
}

function lane(sourceInstanceId: string, overrides: Partial<TriageListLaneV1> = {}): TriageListLaneV1 {
    return {
        sourceInstanceId,
        source: TRIAGE_TESTKIT_SOURCE,
        health: { kind: 'walkFinished' },
        exhausted: true,
        ...overrides,
    };
}

function fold(input: Readonly<{
    observations: readonly CorpusQualifiedObservationV1[];
    lanes?: readonly TriageListLaneV1[];
    lens?: Partial<TriageListLensV1>;
    configuredSourcesStatus?: 'complete' | 'truncated';
    activeSourceInstanceIds?: readonly string[];
}>): TriageListWindowV1 {
    const instanceIds = [...new Set(input.observations.map((entry) => entry.sourceInstanceId))];
    return foldTriageListWindow({
        observations: input.observations,
        lanes: input.lanes ?? instanceIds.map((instanceId) => lane(instanceId)),
        configuredSourcesStatus: input.configuredSourcesStatus ?? 'complete',
        activeSourceInstanceIds: input.activeSourceInstanceIds ?? instanceIds,
        lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, ...input.lens },
        assembledAtMs: 5_000,
    });
}

describe('the content winner of one folded entry', () => {
    /**
     * `core/CORPUS.md` §3.2 and §3.7. Two connections observe one entry and
     * disagree; the alphabetically later one answered later *and* carries the
     * higher provider clock, so an "either clock" winner picks it.
     *
     * Both runs fold the same two observations in opposite array order, because
     * an arrival-order winner answers correctly exactly half the time.
     */
    it('selects displayed content by stable sourceInstanceId rather than by either clock', () => {
        const smallestId = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            observedAtMs: 1_000,
            title: 'A says active',
            displayPath: 'example/repository #17',
            presentation: 'active',
            createdAtMs: 1_000_000,
        });
        const laterClocks = present({
            sourceInstanceId: INSTANCE[1] ?? '',
            observedAtMs: 9_000,
            title: 'B says closed',
            displayPath: 'mirror/repository #17',
            presentation: 'closed',
            createdAtMs: 9_000_000,
        });

        for (const observations of [[smallestId, laterClocks], [laterClocks, smallestId]]) {
            const row = fold({ observations }).rows[0];

            expect(row?.content?.sourceInstanceId).toBe(INSTANCE[0]);
            expect(row?.content?.outcome.snapshot.title).toBe('A says active');
            // §3.2's locator rule: a locator never disagrees with the content it
            // labels, so both come from the one chosen observation.
            expect(row?.content?.outcome.locator.displayPath).toBe('example/repository #17');
            // The lane and the presentation ordinal are that same observation's,
            // so a row filed under Done can never carry an open entry's title.
            expect(row?.lane).toBe('1-open');
            expect(row?.sortAtMs).toBe(1_000_000);
            // Nothing is lost: the other connection is still in the row in full.
            expect(row?.observations).toHaveLength(2);
        }
    });

    it('resolves an equal-clock content winner independently of array order', () => {
        const a = present({ sourceInstanceId: INSTANCE[0] ?? '', observedAtMs: 4_000, title: 'A' });
        const b = present({ sourceInstanceId: INSTANCE[1] ?? '', observedAtMs: 4_000, title: 'B' });

        expect(fold({ observations: [a, b] }).rows[0]?.content?.outcome.snapshot.title).toBe('A');
        expect(fold({ observations: [b, a] }).rows[0]?.content?.outcome.snapshot.title).toBe('A');
    });

    it('keeps the newest answer of the winning connection when it answered twice in one pass', () => {
        // Two pages of one connection are one connection's own clock, which is
        // the only clock comparison this projection is allowed to make.
        const first = present({ sourceInstanceId: INSTANCE[0] ?? '', observedAtMs: 1_000, title: 'Stale page' });
        const second = present({ sourceInstanceId: INSTANCE[0] ?? '', observedAtMs: 2_000, title: 'Newer page' });

        expect(fold({ observations: [first, second] }).rows[0]?.content?.outcome.snapshot.title)
            .toBe('Newer page');
        expect(fold({ observations: [second, first] }).rows[0]?.content?.outcome.snapshot.title)
            .toBe('Newer page');
    });

    it('carries no content and stays in the open lane when no connection reports the entry', () => {
        const row = fold({
            observations: [{
                entryRef: testkitEntryRef(),
                sourceInstanceId: INSTANCE[0] ?? '',
                observedAtMs: 7_000,
                outcome: { kind: 'absent' },
            }],
        }).rows[0];

        expect(row?.content).toBeNull();
        // Calling an entry done because a connection stopped reporting it would
        // retire a live entry.
        expect(row?.lane).toBe('1-open');
        expect(row?.sortAtMs).toBe(7_000);
    });
});

describe('the five-facet filter conjunction', () => {
    const REVIEW_REQUESTED = ['reviewRequested'] as const;

    function filters(overrides: Partial<SurfaceFilterSelectionV1>): SurfaceFilterSelectionV1 {
        return { ...TRIAGE_LIST_NO_FILTERS_V1, ...overrides };
    }

    /**
     * §6.2's named falsifier. A mutual-exclusion reducer, or a planner that
     * ignores one constraint, returns a plausible but wrong row — so the test
     * seeds one row that satisfies every facet and three that each fail exactly
     * one of them.
     */
    it('composes Source, cross-source Type, Scope, State and Attention without clearing a selected facet', () => {
        const match = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'match',
            involvement: REVIEW_REQUESTED,
        });
        const wrongSource = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'wrong-source',
            source: OTHER_SOURCE,
            involvement: REVIEW_REQUESTED,
        });
        const wrongKind = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'wrong-kind',
            kindId: 'issue',
            involvement: REVIEW_REQUESTED,
        });
        const wrongScope = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'wrong-scope',
            collisionScope: 'example/other',
            involvement: REVIEW_REQUESTED,
        });
        const wrongState = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'wrong-state',
            presentation: 'closed',
            involvement: REVIEW_REQUESTED,
        });
        const noAttention = present({ sourceInstanceId: INSTANCE[0] ?? '', entryId: 'no-attention' });

        const window = fold({
            observations: [match, wrongSource, wrongKind, wrongScope, wrongState, noAttention],
            lens: {
                filters: filters({
                    sources: [{ source: TRIAGE_TESTKIT_SOURCE }],
                    types: [{ source: TRIAGE_TESTKIT_SOURCE, kindId: 'pull-request' }],
                    scopes: [{ source: TRIAGE_TESTKIT_SOURCE, collisionScope: 'example/repository' }],
                    states: ['open'],
                    attention: ['required'],
                }),
            },
        });

        expect(window.rows.map((row) => row.entryRef.entryId)).toEqual(['match']);
    });

    it('treats values inside one facet as alternatives across sources', () => {
        const pullRequest = present({ sourceInstanceId: INSTANCE[0] ?? '', entryId: 'pr' });
        const trackerIssue = present({
            sourceInstanceId: INSTANCE[0] ?? '',
            entryId: 'issue',
            source: OTHER_SOURCE,
            kindId: 'issue',
        });

        const window = fold({
            observations: [pullRequest, trackerIssue],
            lens: {
                filters: filters({
                    types: [
                        { source: TRIAGE_TESTKIT_SOURCE, kindId: 'pull-request' },
                        { source: OTHER_SOURCE, kindId: 'issue' },
                    ],
                }),
            },
        });

        expect(window.rows.map((row) => row.entryRef.entryId).sort()).toEqual(['issue', 'pr']);
    });

    it('folds search case with the locale-independent mapping', () => {
        const window = fold({
            observations: [present({ sourceInstanceId: INSTANCE[0] ?? '', title: 'ISSUE in the parser' })],
            lens: { query: 'issue' },
        });

        expect(window.rows).toHaveLength(1);
    });
});

describe('the fair row bound across source lanes', () => {
    function deepLane(instanceId: string, count: number, from: number): readonly CorpusQualifiedObservationV1[] {
        return Array.from({ length: count }, (_unused, index) => present({
            sourceInstanceId: instanceId,
            entryId: `${instanceId}-${String(index)}`,
            createdAtMs: from - index,
        }));
    }

    /**
     * §4.7's named falsifier. One connection holds far more recent entries than
     * the window can carry and the other holds a few older ones. A global rank
     * followed by a single cut fills every slot from the deep connection, and
     * the shallow one is invisible — which reads as a missing integration
     * rather than as a paging choice.
     */
    it('gives every source lane a bounded slice before any lane takes a second one', () => {
        const window = fold({
            observations: [
                ...deepLane(INSTANCE[0] ?? '', 20, 9_000_000),
                ...deepLane(INSTANCE[1] ?? '', 3, 1_000_000),
            ],
            lens: { limit: 10 },
            lanes: [
                lane(INSTANCE[0] ?? '', { health: { kind: 'partial', reason: 'pageLimit' }, exhausted: false }),
                lane(INSTANCE[1] ?? ''),
            ],
        });

        expect(window.rows).toHaveLength(10);
        const byLane = new Map<string, number>();
        for (const row of window.rows) {
            const instanceId = row.content?.sourceInstanceId ?? '';
            byLane.set(instanceId, (byLane.get(instanceId) ?? 0) + 1);
        }
        expect(byLane.get(INSTANCE[1] ?? '')).toBe(3);
        expect(byLane.get(INSTANCE[0] ?? '')).toBe(7);
        // The bound is fair; the order the reader sees is still the lens's.
        expect([...window.rows].map((row) => row.sortAtMs))
            .toEqual([...window.rows].map((row) => row.sortAtMs).sort((left, right) => right - left));
    });

    it('spends no lane turn on an entry another lane already placed', () => {
        // One entry observed through both connections is one row. Taking it on
        // the first lane's turn must not also consume the second lane's turn,
        // or a connection whose entries are all shared would starve.
        const shared = ['s1', 's2'].map((entryId) => [
            present({ sourceInstanceId: INSTANCE[0] ?? '', entryId, createdAtMs: 9_000_000 }),
            present({ sourceInstanceId: INSTANCE[1] ?? '', entryId, createdAtMs: 9_000_000 }),
        ]).flat();
        const window = fold({
            observations: [
                ...shared,
                present({ sourceInstanceId: INSTANCE[1] ?? '', entryId: 'own', createdAtMs: 1_000 }),
            ],
            lens: { limit: 3 },
        });

        expect(window.rows.map((row) => row.entryRef.entryId).sort()).toEqual(['own', 's1', 's2']);
    });

    it('never returns more rows than the published window maximum', () => {
        const window = fold({
            observations: deepLane(INSTANCE[0] ?? '', MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + 5, 9_000_000),
            lens: { limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
        });

        expect(window.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(window.coverage).toBe('partial');
    });
});

describe('the coverage claim', () => {
    it('returns a resumable partial page rather than a healthy empty one when one lane is unfinished', () => {
        const window = fold({
            observations: [],
            lanes: [
                lane(INSTANCE[0] ?? ''),
                lane(INSTANCE[1] ?? '', { health: { kind: 'partial', reason: 'pageLimit' }, exhausted: false }),
            ],
            activeSourceInstanceIds: [INSTANCE[0] ?? '', INSTANCE[1] ?? ''],
        });

        expect(window.rows).toEqual([]);
        expect(window.coverage).toBe('partial');
    });

    it('refuses to claim completeness for a window that asked no source lane', () => {
        // The enumeration-only invocation the mounted store issues on every
        // cycle asks no provider at all. Reporting `complete` for it is an
        // authoritative "nothing needs you" from a call that asked nobody.
        const window = fold({ observations: [], lanes: [], activeSourceInstanceIds: [] });

        expect(window.rows).toEqual([]);
        expect(window.coverage).toBe('partial');
    });

    it('claims completeness only when the configured set was carried whole', () => {
        const exhausted = { observations: [present({ sourceInstanceId: INSTANCE[0] ?? '' })] } as const;

        expect(fold({ ...exhausted }).coverage).toBe('complete');
        expect(fold({ ...exhausted, configuredSourcesStatus: 'truncated' }).coverage).toBe('partial');
    });
});

describe('triageEntryRowKey', () => {
    it('separates two contract-valid entries a delimiter join would merge', () => {
        // `U+001F` is representable inside `collisionScope`, so a delimiter join
        // would give these two distinct entries one key — and put focus and
        // selection on an entry the reader never chose.
        const left = triageEntryRowKey(testkitEntryRef({
            collisionScope: 'origin\u001Fregion',
            entryId: '42',
        }));
        const right = triageEntryRowKey(testkitEntryRef({
            collisionScope: 'origin',
            entryId: '\u001F42',
        }));

        expect(left).not.toBe(right);
    });

    it('groups every connection\'s answer for one entry under one row', () => {
        const window = fold({
            observations: [
                present({ sourceInstanceId: INSTANCE[0] ?? '' }),
                present({ sourceInstanceId: INSTANCE[1] ?? '' }),
                present({ sourceInstanceId: INSTANCE[2] ?? '' }),
            ],
        });

        expect(window.rows).toHaveLength(1);
        expect(window.rows[0]?.observations).toHaveLength(3);
    });
});
