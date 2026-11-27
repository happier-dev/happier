import { describe, expect, it } from 'vitest';

import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import { TriageListFilterSelectionV1Schema } from '../actions/listEntriesProtocol.js';
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
    foldTriagePostMutationObservation,
    createTriageListFoldBaselineV1,
    triageEntryRowKey,
    triageFacetScopeKeyV1,
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

it('keeps repositories with the same short name readable in the pre-filter facet census', () => {
    const observations = ['acme/widgets', 'other/widgets'].map((scopeLabel, index) => ({
        entryRef: testkitEntryRef({ collisionScope: `repo:${index}` }),
        sourceInstanceId: INSTANCE[0]!, observedAtMs: 1_000,
        outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({ scopeLabel, scopeDisplayName: 'widgets' }) }),
    }));
    const window = fold({ observations });
    expect(observations.map(({ entryRef }) => window.facetCensus.scopeNames[
        triageFacetScopeKeyV1(entryRef.source, entryRef.collisionScope)]))
        .toEqual(['acme/widgets', 'other/widgets']);
});

it('filters labels before bounding a page and keeps labels discoverable after narrowing', () => {
    const observations = [['bug', 'urgent'], ['design'], ['docs']].map((labels, index) => ({
        entryRef: testkitEntryRef({ entryId: String(index) }),
        sourceInstanceId: INSTANCE[0]!, observedAtMs: 1_000 + index,
        outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({ labels, createdAtMs: 1_000 + index }) }),
    }));
    const filters = TriageListFilterSelectionV1Schema.parse({ ...TRIAGE_LIST_NO_FILTERS_V1, labels: ['bug', 'design'] });
    const window = fold({ observations, lens: { filters, limit: 1 } });
    expect(window.rows.map(row => row.entryRef.entryId)).toEqual(['1']);
    expect(window.facetCensus.labels).toEqual(expect.arrayContaining(['bug', 'design', 'docs', 'urgent']));
});

it('filters by source-confirmed readiness and keeps unreadable blockers out of Ready', () => {
    const observations = [
        ['ready', { ready: true }],
        ['unreadable', { ready: false, reason: 'blocker_unreadable' }],
        ['blocked', { ready: false, reason: 'blocker_not_terminal' }],
        ['released', { ready: false, reason: 'task_claimed' }],
        ['later-claim', { ready: false, reason: 'task_claimed' }],
        ['unknown', undefined],
    ] as const;
    const rows = observations.map(([entryId, taskReadiness]) => ({
        entryRef: testkitEntryRef({ entryId, kindId: 'task' }), sourceInstanceId: INSTANCE[0]!, observedAtMs: 1_000,
        outcome: testkitPresentOutcome({ snapshot: testkitSnapshot(taskReadiness === undefined ? {} : { taskReadiness, version: 2 }) }),
    }));
    const releasedClaimVersions = Object.fromEntries(rows.filter(({ entryRef }) => entryRef.entryId !== 'ready')
        .map(({ entryRef }) => [triageEntryRowKey(entryRef), entryRef.entryId === 'later-claim' ? 1 : 2]));
    for (const [ready, expected] of [[true, ['ready', 'released']], [false, ['blocked', 'later-claim', 'unreadable']]] as const) {
        const filters = TriageListFilterSelectionV1Schema.parse({ ...TRIAGE_LIST_NO_FILTERS_V1, ready });
        expect(fold({ observations: rows, lens: { filters, releasedClaimVersions } }).rows.map(row => row.entryRef.entryId).sort())
            .toEqual(expected);
    }
    const filters = { ...TRIAGE_LIST_NO_FILTERS_V1, ready: true };
    const window = fold({ observations: rows, lens: { filters, releasedClaimVersions, limit: 1 } });
    expect(window.rows).toHaveLength(1);
    expect(window.notReadyReasonCounts).toEqual({ blocker_not_terminal: 1, blocker_unreadable: 1 });
    const narrowed = fold({ observations: rows, lens: { filters: { ...filters, labels: ['unmatched'] } } });
    expect(narrowed.notReadyReasonCounts).toEqual({ blocker_not_terminal: 0, blocker_unreadable: 0 });
});

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
    scopeUnitId?: string;
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
                ...(input.scopeUnitId === undefined ? {} : { scopeUnitId: input.scopeUnitId }),
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

it('replaces a source routing token without changing the canonical row identity', () => {
    const observation = present({ sourceInstanceId: INSTANCE[0] });
    if (observation.outcome.kind !== 'present') throw new Error('Expected a present source observation');
    const original = {
        ...observation,
        outcome: { ...observation.outcome, locator: testkitLocator({ routingToken: 'old/route' }) },
    };
    const replacement = {
        ...original,
        observedAtMs: original.observedAtMs + 1,
        outcome: { ...original.outcome, locator: testkitLocator({ routingToken: 'new/route' }) },
    };
    const before = fold({ observations: [original] }).rows[0];
    const after = fold({ observations: [original, replacement] }).rows[0];
    expect(after?.entryRef).toEqual(before?.entryRef);
    expect(after?.entryRef && triageEntryRowKey(after.entryRef))
        .toBe(before?.entryRef && triageEntryRowKey(before.entryRef));
    expect(after?.content?.outcome.locator.routingToken).toBe('new/route');
    expect(after?.selected).toEqual(before?.selected);
});

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
    it('projects only changed retained entries and reuses hidden entries across lenses and order', () => {
        const baseline = createTriageListFoldBaselineV1();
        let projected = 0;
        const count = 2_000;
        const observations = Array.from({ length: count }, (_, index) => present({
            sourceInstanceId: INSTANCE[0], entryId: `${index}`, title: `Finding ${index}`, createdAtMs: index,
            kindId: index % 2 === 0 ? 'dependency-finding' : 'scan-finding', involvement: ['assignee'],
        }));
        const project = (answers = observations, lens: Partial<TriageListLensV1> = {}, active = [INSTANCE[0]]) => foldTriageListWindow({
            observations: answers, lanes: [lane(INSTANCE[0])], configuredSourcesStatus: 'complete',
            activeSourceInstanceIds: active, lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: count, ...lens },
            assembledAtMs: 5_000 + projected, baseline, onRowProjected: () => { projected += 1; },
        });
        const first = project();
        expect(first.rows).toHaveLength(count);
        const byId = new Map(first.rows.map(row => [row.entryRef.entryId, row]));
        projected = 0;
        for (let refresh = 0; refresh < 3; refresh += 1) {
            const equal = project(structuredClone(observations).map(observation => ({ ...observation, observedAtMs: 2_000 + refresh })));
            expect(equal).toBe(first);
        }
        expect(projected).toBe(0);
        const changed = structuredClone(observations);
        const target = changed[1];
        if (target?.outcome.kind !== 'present') throw new Error('Missing present fixture');
        changed[1] = { ...target, outcome: { ...target.outcome, snapshot: {
            ...target.outcome.snapshot, title: 'Updated finding', state: { presentation: 'resolved', nativeLabel: 'Fixed' },
        }, viewer: testkitViewer({ sourceAttention: { level: 'none' } }) } };
        const next = project(changed);
        expect(projected).toBe(1);
        expect(next.rows.filter(row => row !== byId.get(row.entryRef.entryId))).toHaveLength(1);
        const updated = next.rows.find(row => row.entryRef.entryId === '1');
        expect(updated?.content?.outcome).toBe(updated?.observations[0]?.outcome);
        expect(updated?.lane).toBe('2-done');
        expect(updated?.attention).toBeNull();
        expect(updated?.content?.outcome.snapshot.facts).toBe(byId.get('1')?.content?.outcome.snapshot.facts);
        const narrow = project(changed, { query: 'Updated' });
        expect(narrow.rows).toEqual([updated]);
        const widened = project(changed, { order: 'oldest' });
        expect(projected).toBe(1);
        expect(widened.rows[0]).toBe(byId.get('0'));
        expect(widened.facetCensus).toBe(first.facetCensus);
        for (let arrival = 0; arrival < 3; arrival += 1) project(changed, {}, [INSTANCE[0], INSTANCE[1]]);
        expect(projected).toBe(1);
        const retired = project(changed, {}, []);
        expect(retired.rows.every(row => row.selected.kind === 'none')).toBe(true);
    });

    it('keeps observation clocks that decide fallback order or unresolved presence and updates coverage without row work', () => {
        const baseline = createTriageListFoldBaselineV1();
        let projected = 0;
        const original = present({ sourceInstanceId: INSTANCE[0], entryId: '1' });
        if (original.outcome.kind !== 'present') throw new Error('Missing present fixture');
        const fallback = { ...original, outcome: { ...original.outcome,
            snapshot: testkitSnapshot({ createdAtMs: undefined }),
        } };
        const project = (observation: CorpusQualifiedObservationV1, exhausted = true) => foldTriageListWindow({
            observations: [observation], lanes: [lane(INSTANCE[0], { exhausted })],
            configuredSourcesStatus: 'complete', activeSourceInstanceIds: [INSTANCE[0]],
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 5_000, baseline,
            onRowProjected: () => { projected += 1; },
        });
        const first = project(fallback);
        const advanced = project({ ...fallback, observedAtMs: 9_000 });
        expect(advanced.rows[0]?.sortAtMs).toBe(9_000);
        expect(advanced.rows[0]).not.toBe(first.rows[0]);
        const partial = project({ ...fallback, observedAtMs: 9_000 }, false);
        expect(partial.rows).toBe(advanced.rows);
        expect(partial.coverage).toBe('partial');
        expect(projected).toBe(2);
        const failed = { ...fallback, outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'offline' } } } as const;
        const unavailable = project(failed);
        const retried = project({ ...failed, observedAtMs: 10_000 });
        expect(retried.rows[0]?.presence).toEqual({ kind: 'unresolved', observedAtMs: 10_000 });
        expect(retried.rows[0]).not.toBe(unavailable.rows[0]);
    });

    it('retains equal nested facts by fact id when their order changes', () => {
        const baseline = createTriageListFoldBaselineV1();
        const original = present({ sourceInstanceId: INSTANCE[0] });
        if (original.outcome.kind !== 'present') throw new Error('Missing present fixture');
        const facts = [
            { id: 'source/first', importance: 'primary', value: { kind: 'status', value: 'First value', tone: 'success' } },
            { id: 'source/second', importance: 'primary', value: { kind: 'status', value: 'Second value', tone: 'success' } },
        ] as const;
        const project = (reversed: boolean) => foldTriageListWindow({
            observations: [{ ...original, outcome: { ...original.outcome, snapshot: testkitSnapshot({
                facts: structuredClone(reversed ? [...facts].reverse() : [...facts]),
            }) } }],
            lanes: [lane(INSTANCE[0])], configuredSourcesStatus: 'complete', activeSourceInstanceIds: [INSTANCE[0]],
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 5_000, baseline,
        });
        const before = project(false).rows[0]?.content?.outcome.snapshot.facts;
        const after = project(true).rows[0]?.content?.outcome.snapshot.facts;
        expect(after?.[0]).toBe(before?.[1]);
        expect(after?.[1]).toBe(before?.[0]);
    });

    it('uses an explicit source-authored collision join only when a unit fact is unavailable', () => {
        const observations = [
            present({ sourceInstanceId: INSTANCE[0], entryId: 'old-shape', collisionScope: 'repository:1' }),
            present({ sourceInstanceId: INSTANCE[0], entryId: 'different-unit', collisionScope: 'repository:1', scopeUnitId: '2' }),
        ];
        const selected = fold({ observations, lens: { filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
            scopes: [{ source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[0], unitId: '1', collisionScope: 'repository:1' }],
        } } });
        expect(selected.rows.map((row) => row.entryRef.entryId)).toEqual(['old-shape']);
        const all = fold({ observations, lens: { filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
            scopes: [{ source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[0] }],
        } } });
        expect(all.rows).toHaveLength(2);
    });

    it('filters source-owned unit ids within a deployment-wide collision scope', () => {
        const observations = [
            present({ sourceInstanceId: INSTANCE[0], entryId: 'project-a', scopeUnitId: 'a' }),
            present({ sourceInstanceId: INSTANCE[0], entryId: 'project-b', scopeUnitId: 'b' }),
            present({ sourceInstanceId: INSTANCE[1], entryId: 'other-account', scopeUnitId: 'a' }),
        ];
        const window = fold({ observations, lens: { filters: {
            ...TRIAGE_LIST_NO_FILTERS_V1,
            scopes: [{ source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[0], unitId: 'a' }],
        } } });
        expect(window.rows.map((row) => row.entryRef.entryId)).toEqual(['project-a']);
        expect(window.facetCensus.scopes).toEqual(expect.arrayContaining([
            { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[0], unitId: 'a' },
            { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[0], unitId: 'b' },
        ]));
        // A shareable lens omits only the configured connection: the same
        // source-owned unit still excludes other units on either connection.
        const sharedFilters = TriageListFilterSelectionV1Schema.parse({
            ...TRIAGE_LIST_NO_FILTERS_V1,
            scopes: [{ source: TRIAGE_TESTKIT_SOURCE, unitId: 'a' }],
        });
        const shared = fold({ observations, lens: { filters: sharedFilters } });
        expect(shared.rows.map((row) => row.entryRef.entryId).sort()).toEqual(['other-account', 'project-a']);
    });

    it('filters by the observing configured instance without losing a shared entry or scanning a different set', () => {
        const observations = [
            present({ sourceInstanceId: INSTANCE[0], entryId: 'first-only' }),
            present({ sourceInstanceId: INSTANCE[1], entryId: 'second-only' }),
            present({ sourceInstanceId: INSTANCE[0], entryId: 'shared' }),
            present({ sourceInstanceId: INSTANCE[1], entryId: 'shared' }),
        ];
        const window = fold({ observations, lens: { filters: {
            ...TRIAGE_LIST_NO_FILTERS_V1,
            sources: [{ source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: INSTANCE[1] }],
        } } });
        expect(window.rows.map((row) => row.entryRef.entryId).sort()).toEqual(['second-only', 'shared']);
        expect(window.rows.find((row) => row.entryRef.entryId === 'shared')?.observations).toHaveLength(2);
        expect(window.lanes).toHaveLength(2);
    });

    it('replaces one connection answer through the canonical fold after a mutation', () => {
        const before = fold({
            observations: [present({
                sourceInstanceId: INSTANCE[0] ?? '',
                observedAtMs: 1_000,
                title: 'Open before the press',
                presentation: 'active',
            })],
        }).rows[0];
        if (before === undefined) throw new Error('fixture row missing');

        const after = foldTriagePostMutationObservation({
            row: before,
            observation: present({
                sourceInstanceId: INSTANCE[0] ?? '',
                observedAtMs: 2_000,
                title: 'Closed after the press',
                presentation: 'closed',
            }),
            lanes: [lane(INSTANCE[0] ?? '')],
            assembledAtMs: 2_000,
        });

        expect(after?.observations).toHaveLength(1);
        expect(after?.content?.outcome.snapshot.title).toBe('Closed after the press');
        expect(after?.lane).toBe('2-done');
    });

    it('reuses an equal exact reread but still retires its execution selection', () => {
        const observation = present({ sourceInstanceId: INSTANCE[0], involvement: ['assignee'] });
        const before = fold({ observations: [observation] }).rows[0];
        if (before === undefined) throw new Error('Missing fixture row');
        const read = { ...structuredClone(observation), observedAtMs: 9_000 };
        const equal = foldTriagePostMutationObservation({ row: before, observation: read,
            lanes: [lane(INSTANCE[0])], assembledAtMs: 9_000 });
        expect(equal).toBe(before);
        const retired = foldTriagePostMutationObservation({ row: before, observation: read,
            lanes: [], assembledAtMs: 9_000 });
        expect(retired?.selected).toEqual({ kind: 'none', reason: 'allInstancesRetired' });
        expect(retired?.content).toBe(before.content);
    });

    it('keeps the reason a scan gave an entry when a selection read replaces its answer', () => {
        const before = fold({
            observations: [present({
                sourceInstanceId: INSTANCE[0] ?? '',
                title: 'Asked of you',
                involvement: ['reviewRequested'],
            })],
        }).rows[0];
        if (before === undefined) throw new Error('fixture row missing');
        expect(before.attention?.reasonLabel).toBe('Review requested');

        // The exact read states the entry's revision and no viewer facts: only a scan learns those.
        const read = present({ sourceInstanceId: INSTANCE[0] ?? '', observedAtMs: 2_000, title: 'Asked of you' });
        const kept = foldTriagePostMutationObservation({
            row: before,
            observation: read,
            lanes: [lane(INSTANCE[0] ?? '')],
            assembledAtMs: 2_000,
            keepViewerFacts: true,
        });
        expect(kept?.attention?.reasonLabel).toBe('Review requested');

        // After a press the same read is the new truth: the request may be gone.
        const pressed = foldTriagePostMutationObservation({
            row: before,
            observation: read,
            lanes: [lane(INSTANCE[0] ?? '')],
            assembledAtMs: 2_000,
        });
        expect(pressed?.attention).toBeNull();
    });

    it('keeps scan summaries on detail arrival and replaces answered facts', () => {
        const checks = { id: 'source/checks', importance: 'primary' as const,
            value: { kind: 'status' as const, value: 'All passing', tone: 'success' as const } };
        const count = { id: 'source/files', importance: 'secondary' as const,
            value: { kind: 'number' as const, value: 17, format: 'plain' as const } };
        const extra = Array.from({ length: 4 }, (_, index) => ({ ...count, id: `source/extra-${index}` }));
        const prior = { ...present({ sourceInstanceId: INSTANCE[0] }), outcome: testkitPresentOutcome({
            snapshot: testkitSnapshot({ facts: [checks, count, ...extra] }),
        }) };
        const before = fold({ observations: [prior] }).rows[0]!;
        const read = { ...present({ sourceInstanceId: INSTANCE[0], observedAtMs: 2_000 }), outcome: testkitPresentOutcome({
            snapshot: testkitSnapshot({ facts: [{ ...count, value: { kind: 'number', value: 0, format: 'plain' } }] }),
        }) };
        const after = foldTriagePostMutationObservation({ row: before, observation: read,
            lanes: [lane(INSTANCE[0])], assembledAtMs: 2_000, keepViewerFacts: true });
        expect(after?.content?.outcome.snapshot.facts).toEqual(expect.arrayContaining([
            checks, { ...count, value: { kind: 'number', value: 0, format: 'plain' } },
            ...extra,
        ]));
        expect(after?.content?.outcome.snapshot.projectionTruncated).toBeUndefined();
        // A post-write read replaces provider truth rather than retaining scan summaries.
        const changed = foldTriagePostMutationObservation({ row: before, observation: read,
            lanes: [lane(INSTANCE[0])], assembledAtMs: 2_000 });
        expect(changed?.content?.outcome.snapshot.facts).not.toContainEqual(checks);
    });

    it('does not carry a missing scan summary across an explicitly changed PR head', () => {
        const revision = { baseSha: 'base', headSha: 'head-before', nativeRevision: 'head-before' };
        const prior = { ...present({ sourceInstanceId: INSTANCE[0] }), outcome: testkitPresentOutcome({
            snapshot: testkitSnapshot({ reviewRevision: revision, facts: [{ id: 'source/checks', importance: 'primary',
                value: { kind: 'status', value: 'All passing', tone: 'success' } }] }),
        }) };
        const before = fold({ observations: [prior] }).rows[0]!;
        const read = { ...present({ sourceInstanceId: INSTANCE[0], observedAtMs: 2_000 }), outcome: testkitPresentOutcome({
            snapshot: testkitSnapshot({ reviewRevision: { ...revision, headSha: 'head-after', nativeRevision: 'head-after' }, facts: [] }),
        }) };
        const after = foldTriagePostMutationObservation({ row: before, observation: read,
            lanes: [lane(INSTANCE[0])], assembledAtMs: 2_000, keepViewerFacts: true });
        expect(after?.content?.outcome.snapshot.facts).toEqual([]);
    });

    it('keeps every active observing connection eligible when post-mutation attention changes', () => {
        const before = fold({
            observations: [
                present({ sourceInstanceId: INSTANCE[0] ?? '', title: 'Primary account' }),
                present({
                    sourceInstanceId: INSTANCE[1] ?? '',
                    title: 'Review account',
                    involvement: ['reviewRequested'],
                }),
            ],
        }).rows[0];
        if (before === undefined) throw new Error('fixture row missing');
        expect(before.selected).toMatchObject({
            kind: 'selected',
            sourceInstanceId: INSTANCE[1],
            reason: 'attention',
        });

        const after = foldTriagePostMutationObservation({
            row: before,
            observation: present({
                sourceInstanceId: INSTANCE[1] ?? '',
                observedAtMs: 2_000,
                title: 'Review completed',
            }),
            lanes: INSTANCE.slice(0, 2).map((sourceInstanceId) => lane(sourceInstanceId)),
            assembledAtMs: 2_000,
        });

        expect(after?.selected).toEqual({
            kind: 'selected',
            sourceInstanceId: INSTANCE[0],
            reason: 'deterministicTieBreak',
        });
    });

    it('retains last-good attention across unresolved exact reads and replaces it on recovery', () => {
        const sourceInstanceId = INSTANCE[0] ?? '';
        const prior = present({
            sourceInstanceId,
            title: 'Review still needed',
            involvement: ['reviewRequested', 'subscribed'],
        });
        const before = fold({ observations: [prior] }).rows[0];
        if (before === undefined) throw new Error('fixture row missing');
        const failure = { class: 'rateLimit', code: 'too-many-requests', retryNotBeforeMs: 32_000 } as const;
        const failedRead: CorpusQualifiedObservationV1 = {
            entryRef: before.entryRef,
            sourceInstanceId,
            observedAtMs: 2_000,
            outcome: { kind: 'unresolved', failure },
        };
        const after = foldTriagePostMutationObservation({
            row: before,
            observation: failedRead,
            lanes: [lane(sourceInstanceId)],
            assembledAtMs: 2_000,
        });

        expect(after?.content).toBe(before.content);
        expect(after?.attention).toEqual(before.attention);
        expect(after?.attention?.level).toBe('required');
        expect(after?.presence).toEqual({ kind: 'unresolved', observedAtMs: 2_000 });
        expect(after?.observations).toEqual([{
            sourceInstanceId,
            observedAtMs: 2_000,
            outcome: { kind: 'unresolved', failure },
        }]);
        expect(after?.selected).toEqual({ kind: 'none', reason: 'noPresentObservation' });
        if (after === null) throw new Error('last-good row missing');

        const stillUnresolved = foldTriagePostMutationObservation({
            row: after,
            observation: { ...failedRead, observedAtMs: 3_000 },
            lanes: [lane(sourceInstanceId)],
            assembledAtMs: 3_000,
        });
        expect(stillUnresolved?.content).toBe(before.content);
        expect(stillUnresolved?.attention).toEqual(before.attention);

        const recovered = foldTriagePostMutationObservation({
            row: after,
            observation: present({ sourceInstanceId, observedAtMs: 33_000, title: 'Review completed' }),
            lanes: [lane(sourceInstanceId)],
            assembledAtMs: 33_000,
        });
        expect(recovered?.content?.outcome.snapshot.title).toBe('Review completed');
        expect(recovered?.attention).toBeNull();
        expect(recovered?.presence).toEqual({ kind: 'present', observedAtMs: 33_000 });
    });

    it('uses another connection current answer when an exact reread is unresolved', () => {
        const failedInstance = INSTANCE[0] ?? '';
        const survivingInstance = INSTANCE[1] ?? '';
        const current = present({
            sourceInstanceId: survivingInstance,
            title: 'Current from another connection',
            observedAtMs: 1_500,
            involvement: ['subscribed'],
        });
        const before = fold({ observations: [
            present({ sourceInstanceId: failedInstance, title: 'Previous winner', involvement: ['reviewRequested'] }),
            current,
        ] }).rows[0];
        if (before === undefined) throw new Error('fixture row missing');
        const failedRead: CorpusQualifiedObservationV1 = {
            entryRef: before.entryRef,
            sourceInstanceId: failedInstance,
            observedAtMs: 2_000,
            outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'server-error' } },
        };
        const after = foldTriagePostMutationObservation({
            row: before,
            observation: failedRead,
            lanes: [lane(failedInstance), lane(survivingInstance)],
            assembledAtMs: 2_000,
        });

        const canonical = fold({ observations: [failedRead, current] }).rows[0];
        expect(after?.content).toEqual(canonical?.content);
        expect(after?.attention).toEqual(canonical?.attention);
        expect(after?.selected).toEqual(canonical?.selected);
        expect(after?.presence).toEqual(canonical?.presence);
        expect(after?.observations).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceInstanceId: failedInstance, outcome: failedRead.outcome }),
        ]));
    });

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
        // Every observed Scope is named for the rail the way its rows name it, not by its identity.
        for (const scope of window.facetCensus.scopes) {
            const name = window.facetCensus.scopeNames[triageFacetScopeKeyV1(scope.source, scope.collisionScope)];
            expect(name, scope.collisionScope).toEqual(expect.any(String));
            expect(name?.length).toBeGreaterThan(0);
        }
        expect(window.facetCensus).toMatchObject({
            types: [
                { source: TRIAGE_TESTKIT_SOURCE, kindId: 'issue' },
                { source: TRIAGE_TESTKIT_SOURCE, kindId: 'pull-request' },
                { source: OTHER_SOURCE, kindId: 'pull-request' },
            ],
            scopes: [
                { source: TRIAGE_TESTKIT_SOURCE, collisionScope: 'example/other' },
                { source: TRIAGE_TESTKIT_SOURCE, collisionScope: 'example/repository' },
                { source: OTHER_SOURCE, collisionScope: 'example/repository' },
            ],
            coverage: 'complete',
        });
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
