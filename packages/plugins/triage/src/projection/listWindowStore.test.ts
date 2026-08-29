import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceFailureV1,
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    type TriageListEntriesInputV1,
} from '../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS } from '../refresh/refreshEligibility.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1, TRIAGE_LIST_DEFAULT_LENS_V1 } from './listWindow.js';
import { createTriageListWindowStore } from './listWindowStore.js';

/**
 * The composed PRs & Issues vertical, driven end to end.
 *
 * Nothing here is a unit stand-in for the aggregate: the store drives the real
 * refresh coordinator, which drives the real aggregate list Action, which reads
 * the real declared `source-instances` Collection through the in-memory store
 * boundary, walks the real published `scan` protocol against fixture sources,
 * and folds the result through the real qualification, presence, attention,
 * selection and ordering owners. Only three genuine boundaries are replaced:
 * the Account Collection store, the host's admitted-contribution view, and the
 * host's Action dispatcher.
 */

const SOURCE_A = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const SOURCE_B = Object.freeze({ pluginId: 'happier.other.source', localId: 'other-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

type ScanFn = (input: TriageScanInputV1) => Promise<TriageScanResultV1>;

function configuredInstance(
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    accountId = 'account-1',
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

function instanceRow(
    tagSeed: string,
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    configuredAtMs: number,
    accountId?: string,
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${tagSeed}${'0'.repeat(43 - tagSeed.length)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs,
        configured: configuredInstance(source, sourceInstanceId, accountId),
    };
}

function presentObservation(input: Readonly<{
    entryId: string;
    title: string;
    sourceUpdatedAtMs: number;
    involvement?: readonly 'reviewRequested'[];
}>): TriageSourceScanObservationV1 {
    return {
        kind: 'present',
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: input.entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: input.title }),
        viewer: testkitViewer(input.involvement ? { involvement: input.involvement } : {}),
        sourceUpdatedAtMs: input.sourceUpdatedAtMs,
    };
}

/**
 * The two page bodies the endless source alternates between, built once.
 *
 * The mount ceiling case makes hundreds of bounded invocations, so rebuilding a
 * full page of observations for each of them measured the fixture rather than
 * the store.
 */
const ENDLESS_PAGES: readonly (readonly TriageSourceScanObservationV1[])[] = Object.freeze([0, 1]
    .map((parity) => Object.freeze(Array.from(
        { length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
        (unused, index) => presentObservation({
            entryId: `p${parity}-${index}`,
            title: `Change ${parity}.${index}`,
            // The first page reads newest, so the newest-first order puts each
            // appended window after the rows already on screen.
            sourceUpdatedAtMs: 1_000_000
                - ((parity === 1 ? 0 : 1) * MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + index),
        }),
    ))));

function endlessPage(parity: number): readonly TriageSourceScanObservationV1[] {
    return ENDLESS_PAGES[parity] ?? [];
}

function createHarness(options: Readonly<{
    admitSourceB?: boolean;
    /** Seeded by default; a single-connection mount is its own configured set. */
    configureSourceA?: boolean;
    configureSourceB?: boolean;
    /** Two distinct configured accounts of one source can observe one canonical entry. */
    sameSourceForB?: boolean;
}> = {}) {
    const admitSourceB = options.admitSourceB ?? true;
    const sourceForB = options.sameSourceForB ? SOURCE_A : SOURCE_B;
    const { collections, control } = createTestkitCorpusCollections();
    if (options.configureSourceA ?? true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow('a', SOURCE_A, INSTANCE_A, 1)));
    }
    if (options.configureSourceB ?? true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
            'b',
            sourceForB,
            INSTANCE_B,
            2,
            options.sameSourceForB ? 'account-2' : undefined,
        )));
    }

    const scans = new Map<object, ScanFn>();
    const scanCalls = { count: 0 };
    const actionInputs: TriageListEntriesInputV1[] = [];

    function admittedSource(
        source: Readonly<{ pluginId: string; localId: string }>,
        scan: ScanFn,
    ): TriageAdmittedSourceV1 {
        const handle = { role: 'scan', of: source.localId };
        scans.set(handle, scan);
        // The admitted entry is a host-created value whose operation handles are
        // deliberately non-constructible; a fixture stands in for the host at
        // that exact boundary and nowhere else.
        return {
            contributor: {
                pluginId: source.pluginId,
                contributionId: source.localId,
                immutableGenerationId: 'generation-1',
            },
            protocol: {
                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
            },
            descriptor: {
                v: 1,
                purpose: 'triage-source',
                displayName: 'Example forge',
                kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
            },
            operations: { listInstances: {}, scan: handle, get: {} },
            surfaces: { detail: {} },
        } as unknown as TriageAdmittedSourceV1;
    }

    const state = {
        titleOfFirstEntry: 'Replace the duplicated normalizer',
        sourceBFails: false,
        sourceBInvocationRejected: false,
        enumerationRejected: false,
        enumerationRepeatsCursor: false,
        /** A typed failure source A answers with instead of a page, when set. */
        sourceAFailure: null as TriageSourceFailureV1 | null,
        /**
         * Source A admits its first page and then fails the continuation — the
         * ordinary shape of a walk that is interrupted part way through.
         */
        sourceASecondPageFails: false,
        /** Holds source B's scan open, standing in for a connection that has not answered yet. */
        holdSourceB: null as Promise<void> | null,
        /**
         * Source A qualifies more observations than one window carries and then
         * reports a settled end — a source whose own provider page is smaller
         * than the page we asked for, finishing on its second one.
         */
        sourceAOverDelivers: false,
        /**
         * Which set of entries the over-delivering walk answers with. Bumping it
         * makes a later pass name entirely different entries while STILL being
         * cut short, which is the shape that must not delete what it never
         * reached.
         */
        sourceAGeneration: 1,
        /**
         * Source A fills the Action's whole observation budget on every page and
         * always offers another — the shape that makes ONE invocation return a
         * bounded window plus a continuation, which is what a mount appends.
         *
         * Its entry ids alternate between two page sets rather than growing with
         * the depth. The first append still reaches entries past the transport
         * bound, which is the product fact; deeper ones re-name entries the
         * merge already holds, which keeps the ceiling case from folding two
         * thousand rows thirty-six times to prove one bound.
         */
        sourceANeverFinishes: false,
        /** Both lanes advance one row at a time so a mixed transport page returns two frontiers. */
        mixedSourcesNeverFinish: false,
    };

    const scanA: ScanFn = async (input) => {
        scanCalls.count += 1;
        if (options.sameSourceForB) {
            const isSecondAccount = input.instance.instance.sourceInstanceId === INSTANCE_B;
            return {
                kind: 'complete',
                observations: [presentObservation({
                    entryId: 'shared-entry',
                    title: isSecondAccount ? 'Second account view' : 'First account view',
                    sourceUpdatedAtMs: isSecondAccount ? 2_000 : 3_000,
                    ...(isSecondAccount ? { involvement: ['reviewRequested'] as const } : {}),
                })],
                evidence: { kind: 'walkFinished' },
            };
        }
        if (state.mixedSourcesNeverFinish) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: `a-${page}`,
                    title: `Source A change ${page}`,
                    sourceUpdatedAtMs: 10_000 - page,
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.sourceAFailure !== null) {
            return { kind: 'failed', failure: state.sourceAFailure };
        }
        if (state.sourceANeverFinishes) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: endlessPage(page % 2),
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.sourceAOverDelivers) {
            const first = input.page.kind === 'initial';
            const count = first ? MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 6 : 20;
            const observations = Array.from({ length: count }, (unused, index) => presentObservation({
                entryId: `${first ? 'first' : 'second'}-${state.sourceAGeneration === 1 ? '' : `g${state.sourceAGeneration}-`}${index}`,
                title: `Change ${first ? 'A' : 'B'}${index}`,
                // A later generation reads OLDER so the first one still outranks
                // it: if the earlier entries survive at all, they are visible.
                sourceUpdatedAtMs: (state.sourceAGeneration === 1 ? 3_000 : 1_000)
                    + (first ? index : count + index),
            }));
            return first
                ? {
                    kind: 'page',
                    observations,
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'page-2' },
                }
                : { kind: 'complete', observations, evidence: { kind: 'walkFinished' } };
        }
        if (input.page.kind === 'initial') {
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: '1',
                    title: state.titleOfFirstEntry,
                    sourceUpdatedAtMs: 3_000,
                    involvement: ['reviewRequested'],
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: 'page-2' },
            };
        }
        if (state.sourceASecondPageFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '2', title: 'Older change', sourceUpdatedAtMs: 1_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const scanB: ScanFn = async (input) => {
        scanCalls.count += 1;
        if (state.sourceBFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        if (state.mixedSourcesNeverFinish) {
            const page = input.page.kind === 'initial' ? 1 : Number(input.page.continuation.token);
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: `b-${page}`,
                    title: `Source B change ${page}`,
                    sourceUpdatedAtMs: 20_000 - page,
                })],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `${page + 1}` },
            };
        }
        if (state.holdSourceB !== null) await state.holdSourceB;
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '3', title: 'Middle change', sourceUpdatedAtMs: 2_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const admitted = options.sameSourceForB
        ? [admittedSource(SOURCE_A, scanA)]
        : admitSourceB
            ? [admittedSource(SOURCE_A, scanA), admittedSource(SOURCE_B, scanB)]
            : [admittedSource(SOURCE_A, scanA)];
    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        const scan = scans.get(operation as unknown as object);
        if (scan === undefined) throw new Error('No admitted scan handle for this operation.');
        return await scan(input);
    };

    const clock = { nowMs: 1_760_000_000_000 };
    const readEntries = async (input: TriageListEntriesInputV1) => {
        actionInputs.push(input);
        // The aggregate read itself is refused: no machine is reachable, so even
        // enumerating the configured instances fails. This is the path a daemon
        // that goes away after a first successful pass takes.
        if (
            state.enumerationRejected
            && input.sources.kind === 'allConfigured'
            && input.limit === 0
        ) {
            throw new Error('The plugin action could not be dispatched: no machine is reachable.');
        }
        // The invocation itself is refused for this one instance — a rejected
        // Action rather than provider evidence about the source.
        if (
            state.sourceBInvocationRejected
            && input.sources.kind === 'selected'
            && input.sources.sourceInstanceIds.includes(INSTANCE_B)
        ) {
            throw new Error('The other forge action was refused.');
        }
        const result = await readAdmittedEntries(input);
        if (
            state.enumerationRepeatsCursor
            && input.sources.kind === 'allConfigured'
            && input.limit === 0
            && input.sources.cursor !== undefined
        ) {
            return { ...result, configuredSourcesStatus: 'truncated' as const, configuredSourcesNextCursor: input.sources.cursor };
        }
        return result;
    };
    const readAdmittedEntries = async (input: TriageListEntriesInputV1) => await listTriageEntries(input, {
        sourceInstances: collections.sourceInstances,
        readAdmittedSources: async () => admitted,
        executeScan,
        nowMs: () => clock.nowMs,
    });

    return { actionInputs, clock, collections, control, readEntries, scanCalls, state };
}

describe('the mounted PRs & Issues window store', () => {
    it('assembles one ordered bounded window from every configured source', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        expect(snapshot.pending).toBe('idle');
        expect(snapshot.freshness).toBe('fresh');
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.configuredSources.map((source) => source.sourceInstanceId))
            .toEqual([INSTANCE_A, INSTANCE_B]);
        // Newest activity first, across two sources and across a walked
        // continuation, with the fold keying on the canonical entry reference.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        expect(snapshot.window?.coverage).toBe('complete');
        expect(snapshot.window?.rows[0]?.attention?.reasonId).toBe('involvement/review-requested');
        // Detail and mutations run under the connection the row's own reason
        // names, not under whichever lane happened to answer first.
        expect(snapshot.window?.rows[0]?.selected).toEqual({
            kind: 'selected',
            sourceInstanceId: INSTANCE_A,
            reason: 'attention',
        });
        const transportPages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0
        ));
        expect(transportPages).toHaveLength(1);
        expect(transportPages[0]?.sources).toEqual({
            kind: 'selected',
            sourceInstanceIds: [INSTANCE_A, INSTANCE_B],
        });
        store.dispose();
    });

    it('enumerates every configured source cursor page then submits sequential transport batches through the same coordinator', async () => {
        const harness = createHarness({ configureSourceB: false });
        for (let index = 0; index < MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `c${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-${String(index + 3)}`,
            )));
        }
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        expect(store.getSnapshot().configuredSources).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);

        const enumerationPages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'allConfigured' && input.limit === 0
        ));
        expect(enumerationPages).toHaveLength(2);
        expect(enumerationPages[0]?.sources).toEqual({ kind: 'allConfigured' });
        expect(enumerationPages[1]?.sources).toMatchObject({
            kind: 'allConfigured',
            cursor: expect.any(String),
        });

        const batches = harness.actionInputs.filter((input) => (
            input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0
        ));
        expect(batches.map((input) => (
            input.sources.kind === 'selected' ? input.sources.sourceInstanceIds.length : 0
        ))).toEqual([MAX_TRIAGE_LIST_SOURCE_BATCH_V1, 1]);
        expect(new Set(batches.flatMap((input) => (
            input.sources.kind === 'selected' ? input.sources.sourceInstanceIds : []
        ))).size).toBe(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);
        store.dispose();
    });

    it('settles a repeated configured-source cursor instead of looping the mounted read', async () => {
        const harness = createHarness({ configureSourceB: false });
        for (let index = 0; index < MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            const sourceInstanceId = `${String(index + 3).padStart(8, '0')}-1111-4111-8111-111111111111`;
            harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow(
                `r${String(index).padStart(4, '0')}x`,
                SOURCE_A,
                sourceInstanceId,
                index + 3,
                `account-r${String(index + 3)}`,
            )));
        }
        harness.state.enumerationRepeatsCursor = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const pages = harness.actionInputs.filter((input) => (
            input.sources.kind === 'allConfigured' && input.limit === 0
        ));
        expect(pages).toHaveLength(2);
        expect(store.getSnapshot().pending).toBe('idle');
        expect(store.getSnapshot().error?.message).toContain('repeated continuation cursor');
        store.dispose();
    });

    it('retains every account observation when one mixed page folds them into one canonical entry', async () => {
        // Two accounts of the same source can legitimately see the same entry.
        // The Action renders the stable content winner (A) in full, while B is
        // the attention/selection winner. Rehydrating only the rendered answer
        // makes the mounted read model choose A again, silently changing where
        // detail and mutations run even though the one mixed Action answered B.
        const harness = createHarness({ sameSourceForB: true });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        try {
            await store.refresh('view');

            const row = store.getSnapshot().window?.rows[0];
            expect(row?.observations.map((observation) => observation.sourceInstanceId))
                .toEqual([INSTANCE_A, INSTANCE_B]);
            expect(row?.attention).toMatchObject({
                level: 'required',
                fromSourceInstanceId: INSTANCE_B,
            });
            expect(row?.selected).toEqual({
                kind: 'selected',
                sourceInstanceId: INSTANCE_B,
                reason: 'attention',
            });
        } finally {
            store.dispose();
        }
    });

    it('goes stale on its own clock and adopts the next pass on refresh', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().freshness).toBe('fresh');

        // Inside the shared minimum interval, view demand joins rather than
        // multiplying into a second provider read.
        const callsAfterFirstPass = harness.scanCalls.count;
        await store.refresh('view');
        expect(harness.scanCalls.count).toBe(callsAfterFirstPass);
        expect(store.getSnapshot().freshness).toBe('fresh');

        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        expect(store.getSnapshot().freshness).toBe('stale');

        harness.state.titleOfFirstEntry = 'Consolidate the two normalizers';
        await store.refresh('view');

        const snapshot = store.getSnapshot();
        expect(harness.scanCalls.count).toBeGreaterThan(callsAfterFirstPass);
        expect(snapshot.freshness).toBe('fresh');
        const first = snapshot.window?.rows[0];
        const outcome = first?.observations[0]?.outcome;
        expect(outcome?.kind === 'present' ? outcome.snapshot.title : null)
            .toBe('Consolidate the two normalizers');
        store.dispose();
    });

    it('publishes the fresh-to-stale transition when its deadline passes', async () => {
        const realSetTimeout = globalThis.setTimeout;
        let freshnessWake: (() => void) | null = null;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, delay, ...args) => {
            if (delay === TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS && typeof handler === 'function') {
                freshnessWake = () => { handler(...args); };
                return 1 as unknown as ReturnType<typeof setTimeout>;
            }
            return realSetTimeout(handler, delay, ...args);
        }) as typeof setTimeout);
        try {
            const harness = createHarness();
            const store = createTriageListWindowStore({
                readEntries: harness.readEntries,
                nowMs: () => harness.clock.nowMs,
            });
            const observedFreshness: string[] = [];
            const unsubscribe = store.subscribe(() => {
                observedFreshness.push(store.getSnapshot().freshness);
            });

            await store.refresh('view');
            expect(store.getSnapshot().freshness).toBe('fresh');
            observedFreshness.length = 0;

            harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS;
            expect(freshnessWake).not.toBeNull();
            freshnessWake?.();

            expect(observedFreshness).toEqual(['stale']);
            unsubscribe();
            store.dispose();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('names the connections it could not reach rather than calling the list unreadable', async () => {
        // The regression this closes, twice repaired and twice survived: the
        // store-wide `error` means "the aggregate list read failed", and the
        // shell renders it as the banner "The list could not be read". Writing it
        // while a window is retained puts that sentence beside rows the reader
        // can see — self-evidently false — with a raw transport string as its
        // body. The enumeration failure is the writer that survived the previous
        // two repairs, because it is only reachable once a first pass has
        // already produced a window.
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows).toHaveLength(3);

        harness.state.enumerationRejected = true;
        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');

        const snapshot = store.getSnapshot();
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        expect(snapshot.error).toBeUndefined();
        // Every connection this pass would have asked is named, because none of
        // them was read — `core/SURFACE.md` §6.2 row 4 asks for the affected
        // connections, not for an anonymous verdict on the list.
        expect((snapshot.unreadableSources ?? []).map((source) => source.sourceInstanceId).sort())
            .toEqual([INSTANCE_A, INSTANCE_B]);
        // And the rows are no longer claimed to be current.
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('still reports a failed aggregate read when no window was ever assembled', async () => {
        // The one honest use of the store-wide slot: there is no list, so "the
        // list could not be read" is exactly what happened.
        const harness = createHarness();
        harness.state.enumerationRejected = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');

        const snapshot = store.getSnapshot();
        expect(snapshot.window).toBeUndefined();
        expect(snapshot.error?.code).toBe('plugin_action_failed');
        store.dispose();
    });

    it('keeps the last known good window when one source fails to refresh', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);

        harness.state.sourceBFails = true;
        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');

        const snapshot = store.getSnapshot();
        // The failing connection's entry is still on screen: a transient
        // provider error must not read as "nothing needs you".
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        // The failure is provider evidence about one named lane, so the lane's
        // own health carries it. Copying it onto the store-wide slot as well
        // gave the same fact two owners, and the surface then presented a
        // single connection's problem as the aggregate list read failing.
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.unreadableSources ?? []).toEqual([]);
        expect(snapshot.freshness).toBe('stale');
        expect(snapshot.window?.lanes.find((lane) => lane.sourceInstanceId === INSTANCE_B)?.health)
            .toEqual({ kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } });
        store.dispose();
    });

    it('keeps the pages a connection admitted before its walk failed', async () => {
        // A walk that fails part way through still gave the pages it gave. The
        // pass owner already retains them (`projection/scanPass.ts`) and the
        // aggregate carries them back, so discarding them here is this mount
        // deleting rows the provider had already answered for: on a cold scan
        // there is no last-known-good behind them, and every page-one row
        // simply vanishes from the list.
        const harness = createHarness();
        harness.state.sourceASecondPageFails = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3']);
        // The lane still reports the failure, and the window still refuses to
        // call the walk finished: keeping the rows is not claiming coverage.
        expect(snapshot.window?.lanes.find((lane) => lane.sourceInstanceId === INSTANCE_A)?.health)
            .toEqual({ kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } });
        expect(snapshot.window?.coverage).toBe('partial');
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('merges the pages a failed walk admitted over the last known good by entry identity', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);

        // The next walk re-reads entry 1 with a newer title and then fails
        // before it reaches entry 2.
        harness.state.titleOfFirstEntry = 'Consolidate the two normalizers';
        harness.state.sourceASecondPageFails = true;
        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');

        const snapshot = store.getSnapshot();
        // Entry 2 was never re-read, so its last known good survives; entry 1
        // was, so the newer answer replaces the retained one rather than
        // listing the same entry twice.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '3', '2']);
        const first = snapshot.window?.rows[0];
        const outcome = first?.observations[0]?.outcome;
        expect(outcome?.kind === 'present' ? outcome.snapshot.title : null)
            .toBe('Consolidate the two normalizers');
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('never deletes what a cut-short pass did not reach', async () => {
        const harness = createHarness({ configureSourceB: false, admitSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const firstPass = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(firstPass.length).toBeGreaterThan(0);

        // The next pass is HEALTHY and answers with entirely different entries,
        // and it is cut short exactly as the first was. The scan-pass owner
        // leaves the walk unexhausted because another native page cannot fit.
        //
        // `PLAN.md` INV-02: no scan establishes absence and the aggregate never
        // derives it by set complement. A pass that never reached the earlier
        // entries has said nothing about them, so they must survive; only a walk
        // that FINISHED enumerating may narrow the lane's set. `core/CORPUS.md`
        // §5.4 names what the missing guard costs: "the set-complement
        // implementation passes every list test and quietly loses user-visible
        // state".
        harness.state.sourceAGeneration = 2;
        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');

        const secondPass = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        // Entries from the first pass survive a second pass that never reached
        // them. Under set-complement replacement this list held only generation
        // two, and everything the reader had been looking at was gone.
        expect(secondPass.some((id) => firstPass.includes(id))).toBe(true);
        store.dispose();
    });

    it('does not call a window current when a configured connection was never read', async () => {
        // Every configured connection is unavailable, so the cycle refused no
        // request and reached no provider at all. Stamping it left the surface
        // saying "Up to date" over a list that had read nothing.
        const harness = createHarness({ configureSourceA: false, admitSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        expect(harness.scanCalls.count).toBe(0);
        expect(snapshot.configuredSources.map((source) => source.available)).toEqual([false]);
        expect(snapshot.window?.rows).toEqual([]);
        expect(snapshot.freshness).toBe('stale');
        store.dispose();
    });

    it('does not claim a finished walk while a configured source has no admitted contribution', async () => {
        const harness = createHarness({ admitSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // The source is still configured; it simply could not be asked. Dropping
        // it from the lane set makes the window claim a completeness it does not
        // have, and an empty list then says every configured source answered.
        expect(snapshot.configuredSources.map((source) => source.available)).toEqual([true, false]);
        expect(snapshot.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_B,
            source: SOURCE_B,
            health: { kind: 'unavailable' },
            exhausted: false,
        });
        expect(snapshot.window?.coverage).toBe('partial');
        // And the window is not current either. One connection answering is not
        // the list being up to date when another was never read at all, and the
        // freshness line is the only place the reader is told which of the two
        // they are looking at.
        expect(snapshot.freshness).toBe('stale');
        // A source this pass never asked is not accused of anything. Naming it
        // here would be the same lost attribution in the other direction: the
        // reader would be told a connection could not be read when nothing ever
        // tried to read it.
        expect(snapshot.unreadableSources ?? []).toEqual([]);
        store.dispose();
    });

    it('preserves each source health inside one mixed Action result', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        harness.state.sourceBFails = true;
        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // `snapshot.error` means one thing: enumerating the configured instances
        // failed, which belongs to no source. Copying one lane's message into it
        // is what let the shell tell a reader "the list could not be read" while
        // the list was on screen in front of them.
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.unreadableSources).toBeUndefined();
        expect(snapshot.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_B,
            source: SOURCE_B,
            health: {
                kind: 'failed',
                failure: { class: 'transient', code: 'provider-busy' },
            },
            exhausted: false,
        });
        // The rows the other connection did admit stay, and the window stops
        // claiming currentness it does not have.
        expect(snapshot.window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);
        expect(snapshot.freshness).toBe('stale');

        await store.refresh('manual');
        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        // The failing lane keeps its own backoff while the healthy lane remains
        // eligible, so the next mixed request carries only the lane pacing
        // admits. A mixed result must not turn one source's health into an
        // aggregate cooldown.
        expect(transportPages.at(-1)?.sources).toEqual({
            kind: 'selected',
            sourceInstanceIds: [INSTANCE_A],
        });
        store.dispose();
    });

    it('serves two concurrent consumers from one walk', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        // The shell list and the Composer picker both demand the window at
        // mount. One store, one coordinator, one pass per configured source.
        await Promise.all([store.refresh('view'), store.refresh('view')]);

        // Source A walks two pages, source B one.
        expect(harness.scanCalls.count).toBe(3);
        expect(store.getSnapshot().window?.rows).toHaveLength(3);
        store.dispose();
    });
    /**
     * `core/CORPUS.md` §4.2: manual **Refresh** honours a live source deadline
     * and must "surface that waiting health rather than bypassing provider
     * authority". The coordinator already decided this; until it was published
     * the press simply did nothing, and both surfaces said nothing.
     */
    it('publishes the coordinator\'s refusal instead of offering a Refresh that does nothing', async () => {
        const harness = createHarness({ admitSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        const deadlineMs = harness.clock.nowMs + 45_000;
        harness.state.sourceAFailure = {
            class: 'rateLimit',
            code: 'secondary-limit',
            retryNotBeforeMs: deadlineMs,
        };

        await store.refresh('view');
        expect(store.getSnapshot().refreshBlocked)
            .toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: deadlineMs });

        // The press the reader would make next reads no provider at all — which
        // is exactly why the refusal has to be visible before they make it.
        const before = harness.scanCalls.count;
        await store.refresh('manual');
        expect(harness.scanCalls.count).toBe(before);
        expect(store.getSnapshot().refreshBlocked)
            .toEqual({ reason: 'sourceRetryDeadline', nextEligibleAtMs: deadlineMs });

        // A deadline that has passed stops being a refusal on the clock, without
        // waiting for a cycle to overwrite it.
        harness.clock.nowMs = deadlineMs;
        expect(store.getSnapshot().refreshBlocked).toBeUndefined();
        store.dispose();
    });

    it('notifies subscribers when the published refresh deadline expires', async () => {
        vi.useFakeTimers();
        try {
            const harness = createHarness({ admitSourceB: false });
            const store = createTriageListWindowStore({
                readEntries: harness.readEntries,
                nowMs: () => harness.clock.nowMs,
            });
            const deadlineMs = harness.clock.nowMs + 45_000;
            harness.state.sourceAFailure = {
                class: 'rateLimit',
                code: 'secondary-limit',
                retryNotBeforeMs: deadlineMs,
            };
            await store.refresh('view');

            const published: unknown[] = [];
            const unsubscribe = store.subscribe(() => {
                published.push(store.getSnapshot().refreshBlocked);
            });
            harness.clock.nowMs = deadlineMs;
            await vi.advanceTimersByTimeAsync(45_000);

            expect(published).toHaveLength(1);
            expect(published.at(-1)).toBeUndefined();
            unsubscribe();
            store.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not age a window from a cycle that read nothing', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        const readAtMs = harness.clock.nowMs;

        await store.refresh('view');
        expect(store.getSnapshot().freshness).toBe('fresh');

        // A view trigger inside the minimum interval reads no provider. Stamping
        // the cycle anyway would extend the fresh window without a read, so the
        // list would keep saying "up to date" about entries nobody re-read.
        harness.clock.nowMs = readAtMs + 10_000;
        const before = harness.scanCalls.count;
        await store.refresh('view');
        expect(harness.scanCalls.count).toBe(before);

        harness.clock.nowMs = readAtMs + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        expect(store.getSnapshot().freshness).toBe('stale');
        store.dispose();
    });

    /**
     * `pendingTrigger` is the intent of ONE cycle, and a cycle that ran it has
     * spent it.
     *
     * Manual **Refresh** is the one trigger the shared minimum interval does not
     * refuse. It was raised for the press and never lowered, so every later view
     * demand — a remount, a focus, a visibility change — inherited the press and
     * read the provider at interaction speed, which is the pacing the interval
     * exists to impose. The intent is consumed at the start of the cycle that
     * carries it, so a manual press queued WHILE a cycle is running still
     * reaches the next one.
     */
    it('stops treating later view demand as the manual press a finished cycle already spent', async () => {
        // This regression needs one valid resumable frontier. The endless-page
        // fixture returns a full transport page, so keep it on the single-source
        // geometry it models rather than submitting that page to a smaller
        // mixed-lane share and testing the page-limit rejection path instead.
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        const readAtMs = harness.clock.nowMs;

        await store.refresh('view');
        // The reader presses Refresh. That intent belongs to the cycle it drives.
        await store.refresh('manual');
        const afterManualPress = harness.scanCalls.count;
        expect(afterManualPress).toBeGreaterThan(0);

        // View demand inside the minimum interval must read nothing at all.
        harness.clock.nowMs = readAtMs + 10_000;
        await store.refresh('view');

        expect(harness.scanCalls.count).toBe(afterManualPress);
        // A paced-away refresh did not happen, so it cannot consume the valid
        // frontier the last successful acquisition returned. The mounted
        // continuation row must remain actionable and resume that frontier.
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        await store.loadMore();
        const lastProviderInput = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        ).at(-1);
        expect(lastProviderInput?.resume).toHaveLength(1);
        store.dispose();
    });

    it('does not load an old continuation while a lens replacement is paced away', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        const readsBeforeLensChange = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        ).length;

        // The lens invalidates the old frontier synchronously, while the
        // coordinator is still inside its minimum interval. Load More must
        // wait for the replacement generation rather than reuse that cursor.
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'older' });
        await store.loadMore();

        const readsAfterAttempt = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        expect(readsAfterAttempt).toHaveLength(readsBeforeLensChange);
        expect(store.getSnapshot().pending).not.toBe('append');
        store.dispose();
    });

    /**
     * The lens is a projection of the retained page, never a parameter of the
     * read.
     *
     * The Action's fold drops every row the lens excludes, and this mount keeps
     * only what came back — so a read taken under the reader's own filter
     * deletes the excluded entries from the mount, and widening the filter
     * again cannot bring them back without another provider read. The reader
     * narrows, widens, and finds entries silently missing.
     */
    it('projects a narrowed lens over the retained page instead of narrowing the read', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'older' });
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['2']);

        // The refresh a reader takes while their filter is narrow.
        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['2']);

        // Clearing it restores every entry the page carried, locally, without
        // reading any provider again.
        const readsBefore = harness.scanCalls.count;
        store.setLens(TRIAGE_LIST_DEFAULT_LENS_V1);
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);
        expect(harness.scanCalls.count).toBe(readsBefore);
        store.dispose();
    });

    it('does not call its window complete when the page it retained was cut', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // The one configured connection qualified more entries than a window
        // carries and then reported a settled end of its walk. Its lane health
        // is therefore honest — the walk did finish — but the window that
        // reached this mount was cut to the row bound first, so the entries
        // past it never arrived and no later read of the retained page can
        // produce them. Reporting `complete` here tells the reader every
        // configured source answered in full, over a list that is missing rows.
        expect(snapshot.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 6);
        expect(snapshot.window?.coverage).toBe('partial');
        store.dispose();
    });

    it('cuts the over-delivered page under the reader own order, not a fixed one', async () => {
        // The mounted store fetches a NEUTRAL page and projects the lens locally,
        // which is right for `query` and the facets: those EXCLUDE rows, so asking
        // the provider to apply them destroys entries that widening the filter
        // should bring back without another read.
        //
        // `order` is not that kind of lens member. It excludes nothing — it RANKS,
        // and `listWindow` ranks before it bounds (`rankCorpusWindow` then
        // `boundAcrossSourceLanes`), so the order in force at the cut decides WHICH
        // rows survive it. Sending a fixed order therefore hands a reader on
        // `oldest` the NEWEST page re-sorted ascending, and no local re-sort can
        // recover the older entries that were already cut away.
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
            lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' },
        });

        await store.refresh('view');
        const snapshot = store.getSnapshot();

        // The connection offered 70 entries stamped oldest-first from `first-0`.
        // A reader asking for the oldest must be given the oldest one there is,
        // not the oldest survivor of a cut taken under someone else's order.
        expect(snapshot.window?.rows[0]?.entryRef.entryId).toBe('first-0');
        store.dispose();
    });

    it('reacquires from page one when query, order, or Smart policy changes', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceAOverDelivers = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const providerReads = () => harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        const afterInitial = providerReads().length;

        // A React rebind may copy the lens and its arrays without changing the
        // reader's request. That is not a new generation and must not spend a
        // provider read merely because object identity changed.
        store.setLens({
            ...TRIAGE_LIST_DEFAULT_LENS_V1,
            filters: {
                sources: [...TRIAGE_LIST_DEFAULT_LENS_V1.filters.sources],
                types: [...TRIAGE_LIST_DEFAULT_LENS_V1.filters.types],
                scopes: [...TRIAGE_LIST_DEFAULT_LENS_V1.filters.scopes],
                states: [...TRIAGE_LIST_DEFAULT_LENS_V1.filters.states],
                attention: [...TRIAGE_LIST_DEFAULT_LENS_V1.filters.attention],
            },
        });
        expect(providerReads()).toHaveLength(afterInitial);

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'older' });
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(afterInitial + 1);
        });
        expect(providerReads().at(-1)?.resume).toBeUndefined();

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' });
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(afterInitial + 2);
        });
        expect(providerReads().at(-1)?.order).toBe('oldest');
        expect(store.getSnapshot().window?.rows[0]?.entryRef.entryId).toBe('first-0');

        store.setLens({
            ...TRIAGE_LIST_DEFAULT_LENS_V1,
            order: 'oldest',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(afterInitial + 3);
        });
        expect(providerReads().at(-1)?.smartPolicy).toEqual({
            v: 1,
            precedence: ['activity', 'attention'],
        });

        store.dispose();
    });

    it('discards the old frontier when a filter changes after Load More', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();

        store.setLens({
            ...TRIAGE_LIST_DEFAULT_LENS_V1,
            filters: {
                ...TRIAGE_LIST_DEFAULT_LENS_V1.filters,
                states: ['open'],
            },
        });

        const providerReads = () => harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(3);
        });
        expect(providerReads().at(-1)?.resume).toBeUndefined();
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);

        store.dispose();
    });

    it('replaces the old paging generation when order changes', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' });
        const providerReads = () => harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        await vi.waitFor(() => {
            expect(providerReads()).toHaveLength(3);
            const rows = store.getSnapshot().window?.rows ?? [];
            expect(rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
            expect(rows.every((row) => row.entryRef.entryId.startsWith('p1-'))).toBe(true);
        });

        const reacquisition = providerReads().at(-1);
        expect(reacquisition?.resume).toBeUndefined();
        expect(reacquisition?.order).toBe('oldest');
        const reacquiredIds = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(reacquiredIds).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(reacquiredIds.every((entryId) => entryId.startsWith('p1-'))).toBe(true);

        store.dispose();
    });

    it('keeps the new-order generation pending until a failed reacquisition recovers', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        await store.loadMore();
        harness.state.sourceANeverFinishes = false;
        harness.state.sourceAFailure = { class: 'transient', code: 'provider-busy' };

        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, order: 'oldest' });
        await vi.waitFor(() => {
            expect(store.getSnapshot().pending).toBe('idle');
            expect(store.getSnapshot().window?.lanes[0]?.health.kind).toBe('failed');
        });

        harness.state.sourceAFailure = null;
        harness.state.sourceANeverFinishes = true;
        const retryAtMs = store.getSnapshot().refreshBlocked?.nextEligibleAtMs;
        if (retryAtMs === undefined) throw new Error('failed lane did not publish its retry deadline');
        harness.clock.nowMs = retryAtMs;
        await store.refresh('manual');

        const recoveredIds = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId) ?? [];
        expect(recoveredIds).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(recoveredIds.every((entryId) => entryId.startsWith('p1-'))).toBe(true);

        store.dispose();
    });

    it('does not call a window stale because the reader changed the lens', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().freshness).toBe('fresh');

        // The page the lens is projected from is exactly as fresh as the read
        // that produced it. Typing in the search box reads no provider and ages
        // nothing, so "stale" here would ask the reader to refresh away a
        // filter they just applied.
        store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'older' });
        expect(store.getSnapshot().freshness).toBe('fresh');
        store.dispose();
    });

    it('publishes one mixed Action result after every included connection settles', async () => {
        const harness = createHarness();
        let release = (): void => {};
        harness.state.holdSourceB = new Promise<void>((resolve) => { release = resolve; });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        /** Every window published while the cycle was still running. */
        const published: string[][] = [];
        const unsubscribe = store.subscribe(() => {
            const snapshot = store.getSnapshot();
            if (snapshot.pending === 'idle' || snapshot.window === undefined) return;
            published.push(snapshot.window.rows.map((row) => row.entryRef.entryId));
        });

        const cycle = store.refresh('view');
        try {
            // A mixed Action has one result boundary, so it cannot publish a
            // per-source half-result before the included connections settle.
            for (let turn = 0; turn < 100 && published.length === 0; turn += 1) {
                await new Promise((resolve) => { setTimeout(resolve, 0); });
            }
            expect(published).toEqual([]);
        } finally {
            release();
        }

        await cycle;
        unsubscribe();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(['1', '3', '2']);
        expect(store.getSnapshot().pending).toBe('idle');
        store.dispose();
    });
});

/**
 * The 56-row Action response bound is a transport limit and stays one. What is
 * proved here is that it stopped being a PRODUCT limit: entry 57 is reachable,
 * the rows already on screen survive a page that fails, and nothing durable is
 * created to make either true.
 */
describe('appending another bounded window to one mount', () => {
    /** A mount of the endless source alone, already holding its first window. */
    async function mountedAtFirstWindow() {
        const harness = createHarness({ configureSourceB: false });
        harness.state.sourceANeverFinishes = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });
        await store.refresh('view');
        return { harness, store };
    }

    it('offers nothing to append before a window exists', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        // Not `available`: pressing it is refused, because there is nothing to
        // append to yet. A published `available` here was an offer the store had
        // already decided to do nothing about.
        expect(store.getSnapshot().loadMore).toBeUndefined();
        await store.loadMore();
        expect(harness.scanCalls.count).toBe(0);

        store.dispose();
    });

    it('reaches the entries after the transport bound and keeps the ones already on screen', async () => {
        const { harness, store } = await mountedAtFirstWindow();

        const first = store.getSnapshot();
        expect(first.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(first.window?.coverage).toBe('partial');
        expect(first.loadMore).toEqual({ kind: 'available' });

        await store.loadMore();

        const appended = store.getSnapshot();
        // Twice the transport bound in one mount, from two bounded invocations —
        // the per-invocation page contract is untouched.
        expect(appended.window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
        const ids = appended.window?.rows.map((row) => row.entryRef.entryId) ?? [];
        // Every row of the first window is still there, in front of the new ones.
        expect(ids.slice(0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1))
            .toEqual(first.window?.rows.map((row) => row.entryRef.entryId));
        expect(ids).toContain('p0-0');
        expect(appended.loadMore).toEqual({ kind: 'available' });

        store.dispose();
    });

    it('keeps the earlier pages when the resumed page finishes the lane', async () => {
        const harness = createHarness({ configureSourceB: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1']);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });

        // The continuation is the lane's terminal page. Finishing the walk is
        // evidence that there is nothing after this page; it is not permission
        // to replace the pages this same mounted generation already retained.
        await store.loadMore();

        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId)).toEqual(['1', '2']);
        expect(store.getSnapshot().window?.coverage).toBe('complete');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        store.dispose();
    });

    it('carries every active lane frontier through one mixed invocation per transport page', async () => {
        const harness = createHarness();
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const scanInputsAfterRefresh = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        expect(scanInputsAfterRefresh).toHaveLength(1);
        expect(scanInputsAfterRefresh[0]?.sources).toEqual({
            kind: 'selected',
            sourceInstanceIds: [INSTANCE_A, INSTANCE_B],
        });

        await store.loadMore();

        // Load More resumes both still-active lanes together exactly once. It
        // neither replays page one nor fans the frontier out into one Action per
        // source.
        const scanInputsAfterLoadMore = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        expect(scanInputsAfterLoadMore).toHaveLength(2);
        expect(scanInputsAfterLoadMore[1]?.sources).toEqual(
            { kind: 'selected', sourceInstanceIds: [INSTANCE_A, INSTANCE_B] },
        );
        expect(scanInputsAfterLoadMore[1]?.resume?.map((entry) => entry.sourceInstanceId))
            .toEqual([INSTANCE_A, INSTANCE_B]);
        const resumedPages = scanInputsAfterLoadMore[1]?.resume?.map(
            (entry) => Number(entry.continuation.token),
        ) ?? [];
        expect(resumedPages).toHaveLength(2);
        expect(resumedPages.every((page) => page > 1)).toBe(true);

        await store.loadMore();
        const afterSecondAppend = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        expect(afterSecondAppend).toHaveLength(3);
        const secondResumedPages = afterSecondAppend[2]?.resume?.map(
            (entry) => Number(entry.continuation.token),
        ) ?? [];
        expect(secondResumedPages).toHaveLength(2);
        expect(secondResumedPages.every((page, index) => page > (resumedPages[index] ?? 0))).toBe(true);

        store.dispose();
    });

    it('restarts the mixed paging generation when a configured source appears before Load More', async () => {
        const harness = createHarness({ configureSourceB: false });
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        harness.control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2)));

        await store.loadMore();

        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        // Source B cannot join A's prior frontier: a configured-set change is
        // a new mixed acquisition generation, so both start from their first
        // page under the same Action invocation.
        expect(transportPages).toHaveLength(2);
        expect(transportPages[1]?.sources).toEqual({
            kind: 'selected',
            sourceInstanceIds: [INSTANCE_A, INSTANCE_B],
        });
        expect(transportPages[1]?.resume).toBeUndefined();
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-1', 'b-1']));

        await store.loadMore();
        const resumed = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        ).at(-1);
        expect(resumed?.resume?.map((entry) => entry.sourceInstanceId))
            .toEqual([INSTANCE_A, INSTANCE_B]);
        const resumedPages = resumed?.resume?.map((entry) => Number(entry.continuation.token)) ?? [];
        expect(resumedPages).toHaveLength(2);
        expect(resumedPages.every((page) => page > 1)).toBe(true);

        store.dispose();
    });

    it('keeps paging healthy frontiers when one lane fails', async () => {
        const harness = createHarness();
        harness.state.mixedSourcesNeverFinish = true;
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        const initialFrontiers = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        ).at(-1)?.resume;
        harness.state.sourceBFails = true;
        await store.loadMore();

        const afterFailure = store.getSnapshot();
        expect(afterFailure.loadMore).toEqual({ kind: 'available' });
        expect(afterFailure.window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-1', 'a-2', 'b-1']));
        expect(afterFailure.window?.lanes).toContainEqual({
            sourceInstanceId: INSTANCE_B,
            source: SOURCE_B,
            health: {
                kind: 'failed',
                failure: { class: 'transient', code: 'provider-busy' },
            },
            exhausted: false,
        });

        await store.loadMore();
        const transportPages = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        );
        expect(transportPages.at(-1)?.sources).toEqual({
            kind: 'selected',
            sourceInstanceIds: [INSTANCE_A],
        });
        expect(transportPages.at(-1)?.resume).toHaveLength(1);
        expect(Number(transportPages.at(-1)?.resume?.[0]?.continuation.token))
            .toBeGreaterThan(Number(initialFrontiers?.[0]?.continuation.token ?? 0));
        expect(store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId))
            .toEqual(expect.arrayContaining(['a-3', 'b-1']));

        store.dispose();
    });

    it('keeps every retained row when the append fails, and retries at the same depth', async () => {
        const { harness, store } = await mountedAtFirstWindow();
        const retained = store.getSnapshot().window?.rows.map((row) => row.entryRef.entryId);

        // The aggregate read is refused outright: no machine is reachable. The
        // append the reader pressed for never arrives.
        harness.state.enumerationRejected = true;
        await store.loadMore();

        const failed = store.getSnapshot();
        expect(failed.loadMore).toEqual({ kind: 'failed' });
        // The rows are untouched, and the sentence "the list could not be read"
        // is not published beside them.
        expect(failed.window?.rows.map((row) => row.entryRef.entryId)).toEqual(retained);
        expect(failed.error).toBeUndefined();

        harness.state.enumerationRejected = false;
        await store.loadMore();

        // A retry, not a second increment: the depth asked for is the one that
        // failed, so exactly two windows come back rather than three.
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * 2);
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });

        store.dispose();
    });

    it('refresh discards retained frontiers and restarts once from page one', async () => {
        const { harness, store } = await mountedAtFirstWindow();
        await store.loadMore();
        const callsAtDepthTwo = harness.scanCalls.count;

        harness.clock.nowMs += TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1;
        await store.refresh('manual');

        expect(harness.scanCalls.count).toBe(callsAtDepthTwo + 1);
        expect(store.getSnapshot().window?.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        const lastProviderInput = harness.actionInputs.filter(
            (input) => input.sources.kind === 'selected' && input.sources.sourceInstanceIds.length > 0,
        ).at(-1);
        expect(lastProviderInput?.resume).toBeUndefined();

        store.dispose();
    });

    it('offers nothing further once every connection finished its walk', async () => {
        const harness = createHarness();
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        expect(store.getSnapshot().window?.coverage).toBe('complete');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'exhausted' });

        const calls = harness.scanCalls.count;
        await store.loadMore();
        expect(harness.scanCalls.count).toBe(calls);

        store.dispose();
    });

    /**
     * An incomplete result and a resumable frontier are two different facts, and
     * only the second one is a place to continue from.
     *
     * A configured connection with no admitted contribution leaves the window
     * `partial` forever: nothing walked it, so nothing exhausted it. Reading the
     * coverage claim as the offer published `available`, and every press then
     * deepened the mount by one and re-read page one of the connections that DID
     * answer — the same rows again, deduped away, until the mount ceiling. The
     * reader is told the list is incomplete and pointed at **Refresh** instead.
     */
    it('does not offer a deeper window when no connection left a frontier to resume', async () => {
        const harness = createHarness({ admitSourceB: false, configureSourceA: false });
        const store = createTriageListWindowStore({
            readEntries: harness.readEntries,
            nowMs: () => harness.clock.nowMs,
        });

        await store.refresh('view');
        // The configured source could not be asked at all. The window is
        // honestly incomplete and there is nothing to page.
        expect(store.getSnapshot().window?.coverage).toBe('partial');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'unresumable' });

        const calls = harness.scanCalls.count;
        await store.loadMore();
        // The published arm and the gate read the same fact, so the press the
        // row does not offer is also the press this store refuses.
        expect(harness.scanCalls.count).toBe(calls);
        store.dispose();
    });

    it('keeps every source continuation reachable beyond the former 2,000-row mount wall', async () => {
        const { harness, store } = await mountedAtFirstWindow();

        // The retired ceiling was ceil(2,000 / 56) = 36 windows. Walk one page
        // beyond it: the only authority to stop is provider exhaustion, not an
        // invented process-local product count.
        for (let depth = 1; depth <= 36; depth += 1) {
            expect(store.getSnapshot().loadMore, `depth ${depth}`).toEqual({ kind: 'available' });
            await store.loadMore();
        }

        // This fixture deliberately keeps returning a continuation. The next
        // source page therefore remains reachable.
        expect(store.getSnapshot().window?.coverage).toBe('partial');
        expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
        const calls = harness.scanCalls.count;
        await store.loadMore();
        expect(harness.scanCalls.count).toBeGreaterThan(calls);

        store.dispose();
    }, 60_000);
});
