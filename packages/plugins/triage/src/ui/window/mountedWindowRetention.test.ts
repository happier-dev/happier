import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { listTriageEntries, type TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { reobserveTriageEntry } from '../../actions/reobserveEntry.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import { findConfiguredSourceInstanceRow } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../../corpus/testkit/corpusCollections.test-support.js';
import { TESTKIT_SOURCE_INSTANCE_ID, TRIAGE_TESTKIT_SOURCE, testkitEntryRef, testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { retainTriageLastKnownRowV1 } from '../shell/lastKnownRow.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './ephemeralSharedScope.test-support.js';
import { acquireTriageListWindow, loadMoreTriageListWindow, readTriageListWindowReadOwner, refreshTriageListWindow, type TriageListWindowHostV1 } from './mountedWindow.js';

function present(entryId: string) {
    return {
        kind: 'present' as const,
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId },
        locator: testkitLocator(), snapshot: testkitSnapshot({ title: entryId }), viewer: testkitViewer(),
    };
}

// Real mounted owner, aggregate, qualification and Collection logic. Only the
// host's admitted handles, provider execution and persistence are boundaries.
function mountSource() {
    const { collections, control } = createTestkitCorpusCollections();
    const seeded = control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: 'a'.repeat(43),
        sourceQualifiedId: `${TRIAGE_TESTKIT_SOURCE.pluginId}/${TRIAGE_TESTKIT_SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1, instance: { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID },
            binding: { purpose: 'triage-source', account: {
                service: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1',
            } },
            localInstanceKey: 'example/repository', configuration: { v: 1, token: 'routing-token' },
        }),
    }));
    // Branded handles originate in the genuine host, outside this plugin owner.
    const admitted = {
        contributor: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, contributionId: TRIAGE_TESTKIT_SOURCE.localId, immutableGenerationId: 'generation-1' },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
        operations: { listInstances: {}, scan: {}, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    const state = {
        scan: async (_input: TriageScanInputV1): Promise<TriageScanResultV1> => ({
            kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('baseline')],
        }),
    };
    const pages: TriageScanInputV1['page'][] = [];
    const host: TriageListWindowHostV1 = {
        async executeAction(_action, rawInput, options) {
            return listTriageEntries(await selectTestkitExternalSourceInput(
                TriageListEntriesInputV1Schema.parse(rawInput), collections.sourceInstances,
            ), {
                sourceInstances: collections.sourceInstances,
                readSourceSnapshot: async () => ({ contributions: [admitted] }),
                executeScan: async (_operation, input) => { pages.push(input.page); return state.scan(input); },
                nowMs: () => Date.now(), signal: options?.signal,
            });
        },
    };
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('daemon-a');
    const lease = acquireTriageListWindow(host, scope);
    const store = readTriageListWindowReadOwner(host, scope)!;
    return {
        state, pages, store,
        refresh: () => refreshTriageListWindow('manual', host, scope),
        loadMore: () => loadMoreTriageListWindow(host, scope),
        async exact(entryId: string) {
            const result = await reobserveTriageEntry({ entryRef: testkitEntryRef({ entryId }), sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID }, {
                readConfiguredInstance: async (id, options) => (await findConfiguredSourceInstanceRow(collections.sourceInstances, id, options))?.value.configured ?? null,
                readSourceSnapshot: async () => ({ contributions: [admitted] }),
                executeGet: async () => ({ ...present(entryId), snapshot: testkitSnapshot({ title: `Exact ${entryId}` }) }), nowMs: () => Date.now(),
            });
            expect(result.kind).toBe('observed');
            if (result.kind === 'observed') expect(store.publishObservation(result.observation)).not.toBeNull();
        },
        assertSourceUnchanged: () => expect(control.sourceInstances.inspect(seeded.rowId)).toEqual({ revision: seeded.revision, deleted: false }),
        dispose() { lease.release(); lifetime.retire(); },
    };
}

it.each(['rateLimit', 'pagingFailure', 'transportRejection'] as const)(
    'retains the exact row and accepted first page after mounted %s, then restarts from the initial page',
    async failure => {
        const fixture = mountSource();
        let release = () => {};
        try {
            await fixture.refresh();
            await fixture.exact('baseline');
            let continuationStarted = false;
            const held = new Promise<void>(resolve => { release = resolve; });
            fixture.state.scan = async input => {
                if (input.page.kind === 'initial') return {
                    kind: 'page', evidence: { kind: 'partial', reason: 'more-pages' },
                    observations: [present('accepted-early')], continuation: { v: 1, token: 'second-page' },
                };
                continuationStarted = true;
                await held;
                if (failure === 'transportRejection') throw new PluginError({ code: 'provider_transport_unavailable', retryable: true });
                return { kind: 'failed', failure: failure === 'rateLimit'
                    ? { class: 'rateLimit', code: 'provider-rate-limit' }
                    : { class: 'transient', code: 'provider-paging-failed' } };
            };
            await fixture.refresh();
            expect(fixture.store.getSnapshot().window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['accepted-early', 'baseline']);
            const pending = fixture.loadMore();
            await vi.waitFor(() => expect(continuationStarted).toBe(true));
            expect(fixture.store.getRow(triageEntryRowKey(testkitEntryRef({ entryId: 'baseline' })))?.content?.outcome.snapshot.title).toBe('Exact baseline');
            release();
            await pending;

            const snapshot = fixture.store.getSnapshot();
            expect(snapshot.window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['accepted-early', 'baseline']);
            expect(fixture.store.getRow(triageEntryRowKey(testkitEntryRef({ entryId: 'baseline' })))?.content?.outcome.snapshot.title).toBe('Exact baseline');
            expect(snapshot.window?.coverage).toBe('partial');
            expect(snapshot.freshness).toBe('stale');
            const lane = snapshot.window?.lanes.find(candidate => candidate.sourceInstanceId === TESTKIT_SOURCE_INSTANCE_ID);
            expect(lane?.exhausted).toBe(false);
            expect(lane?.health).toMatchObject(failure === 'transportRejection'
                ? { kind: 'unavailable', error: { code: 'provider_transport_unavailable', retryable: true } }
                : { kind: 'failed', failure: { class: failure === 'rateLimit' ? 'rateLimit' : 'transient', code: failure === 'rateLimit' ? 'provider-rate-limit' : 'provider-paging-failed' } });
            expect(snapshot.window?.rows.flatMap(row => row.observations).every(observation => observation.outcome.kind === 'present')).toBe(true);
            fixture.assertSourceUnchanged();

            fixture.pages.length = 0;
            fixture.state.scan = async () => ({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('recovered')] });
            await fixture.refresh();
            expect(fixture.pages.map(page => page.kind)).toEqual(['initial']);
        } finally { release(); fixture.dispose(); }
    },
);

it('keeps the selected exact-read row present when a completed walk omits its scan membership', async () => {
    const fixture = mountSource();
    try {
        await fixture.refresh();
        await fixture.exact('baseline');
        const key = triageEntryRowKey(testkitEntryRef({ entryId: 'baseline' }));
        const selection = { sectionId: '1-open', entryRef: testkitEntryRef({ entryId: 'baseline' }), sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID };
        const held = retainTriageLastKnownRowV1(null, selection, fixture.store.getRow(key));
        expect(held?.row.presence.kind).toBe('present');
        fixture.state.scan = async () => ({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('replacement')] });
        await fixture.refresh();
        // Enumeration membership may narrow. The shell's existing selected-row
        // owner preserves presentation, without inventing an entity absence.
        const retained = retainTriageLastKnownRowV1(held, selection, fixture.store.getRow(key));
        expect(retained?.row.observations.map(observation => observation.outcome.kind)).toEqual(['present']);
        expect(retained?.row.content?.outcome.snapshot.title).toBe('Exact baseline');
        expect(retained?.row.lane).toBe(held?.row.lane);
        expect(fixture.store.getSnapshot().window?.rows.flatMap(row => row.observations).some(observation => observation.outcome.kind === 'absent')).toBe(false);
        expect(fixture.store.getSnapshot().window?.coverage).toBe('complete');
        fixture.assertSourceUnchanged();
    } finally { fixture.dispose(); }
});
