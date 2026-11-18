import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageGetResultV1,
} from '@happier-dev/triage-protocol/v1';

import { createNoPersistenceTriageFixture } from '../../projection/noPersistence.test-support.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { reobserveTriageEntry } from '../../actions/reobserveEntry.js';
import { findConfiguredSourceInstanceRow } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { TESTKIT_SOURCE_INSTANCE_ID, testkitEntryRef, testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
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
    const fixture = createNoPersistenceTriageFixture({ sourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], externalOnly: true });
    const { collections, admitted } = fixture;
    const state = {
        scan: async (_input: TriageScanInputV1): Promise<TriageScanResultV1> => ({
            kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [present('baseline')],
        }),
    };
    const pages: TriageScanInputV1['page'][] = [];
    let nowMs = Date.now();
    const host: TriageListWindowHostV1 = {
        async executeAction(_action, rawInput, options) {
            fixture.setScan(async (_operation, input) => { pages.push(input.page); return state.scan(input); });
            return fixture.readEntries(TriageListEntriesInputV1Schema.parse(rawInput), options);
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
        async exact(entryId: string, outcome?: TriageGetResultV1) {
            const result = await reobserveTriageEntry({ entryRef: testkitEntryRef({ entryId }), sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID }, {
                readConfiguredInstance: async (id, options) => (await findConfiguredSourceInstanceRow(collections.sourceInstances, id, options))?.value.configured ?? null,
                readSourceSnapshot: async () => ({ contributions: [admitted] }),
                executeGet: async () => outcome ?? ({ ...present(entryId), snapshot: testkitSnapshot({ title: `Exact ${entryId}` }) }), nowMs: () => ++nowMs,
            });
            expect(result.kind).toBe('observed');
            if (result.kind === 'observed') expect(store.publishObservation(result.observation)).not.toBeNull();
        },
        assertSourceUnchanged: () => expect(fixture.durableWriteAttempts).toEqual([]),
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

it.each(['unresolved', 'absent'] as const)('establishes absence only from the exact absent result, with %s as the current answer', async kind => {
    const fixture = mountSource();
    try {
        await fixture.refresh();
        await fixture.exact('baseline');
        const localRef = present('baseline').localRef;
        await fixture.exact('baseline', kind === 'absent'
            ? { kind, localRef }
            : { kind, localRef, failure: { class: 'permission', code: 'source-forbidden' } });
        const row = fixture.store.getRow(triageEntryRowKey(testkitEntryRef({ entryId: 'baseline' })));
        expect(row?.presence.kind).toBe(kind);
        expect(row?.content?.outcome.snapshot.title).toBe(kind === 'absent' ? undefined : 'Exact baseline');
        expect(row?.observations.map(observation => observation.outcome.kind)).toEqual([kind]);
        fixture.assertSourceUnchanged();
    } finally { fixture.dispose(); }
});
