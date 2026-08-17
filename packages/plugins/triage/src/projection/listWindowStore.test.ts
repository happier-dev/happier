import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import type { TriageListEntriesInputV1 } from '../actions/listEntriesProtocol.js';
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
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: 'account-1' },
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
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${tagSeed}${'0'.repeat(43 - tagSeed.length)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs,
        configured: configuredInstance(source, sourceInstanceId),
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

function createHarness(options: Readonly<{ admitSourceB?: boolean }> = {}) {
    const admitSourceB = options.admitSourceB ?? true;
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('a', SOURCE_A, INSTANCE_A, 1)));
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2)));

    const scans = new Map<object, ScanFn>();
    const scanCalls = { count: 0 };

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
    };

    const scanA: ScanFn = async (input) => {
        scanCalls.count += 1;
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
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '2', title: 'Older change', sourceUpdatedAtMs: 1_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const scanB: ScanFn = async () => {
        scanCalls.count += 1;
        if (state.sourceBFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '3', title: 'Middle change', sourceUpdatedAtMs: 2_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const admitted = admitSourceB
        ? [admittedSource(SOURCE_A, scanA), admittedSource(SOURCE_B, scanB)]
        : [admittedSource(SOURCE_A, scanA)];
    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        const scan = scans.get(operation as unknown as object);
        if (scan === undefined) throw new Error('No admitted scan handle for this operation.');
        return await scan(input);
    };

    const clock = { nowMs: 1_760_000_000_000 };
    const readEntries = async (input: TriageListEntriesInputV1) => await listTriageEntries(input, {
        sourceInstances: collections.sourceInstances,
        readAdmittedSources: async () => admitted,
        executeScan,
        nowMs: () => clock.nowMs,
    });

    return { clock, readEntries, scanCalls, state };
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
        store.dispose();
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
        expect(snapshot.error?.code).toBe('provider-busy');
        expect(snapshot.freshness).toBe('stale');
        expect(snapshot.window?.lanes.find((lane) => lane.sourceInstanceId === INSTANCE_B)?.health)
            .toEqual({ kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } });
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
});
