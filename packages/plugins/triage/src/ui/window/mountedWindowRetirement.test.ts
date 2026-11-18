import { expect, it, vi } from 'vitest';
import { createNoPersistenceTriageFixture } from '../../projection/noPersistence.test-support.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './ephemeralSharedScope.test-support.js';
import {
    acquireTriageListWindow,
    readTriageListWindowReadOwner,
    refreshTriageListWindow,
    type TriageListWindowHostV1,
} from './mountedWindow.js';

it('keeps a retired populated mount inert when its admitted provider scan settles late', async () => {
    const source = { pluginId: 'happier.example.source', localId: 'example-forge' };
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const fixture = createNoPersistenceTriageFixture({ sourceInstanceIds: [sourceInstanceId], externalOnly: true });
    let held: Promise<void> | undefined;
    let release = () => {};
    const scanState: { signal?: AbortSignal } = {};
    let entryId = 'baseline';
    const host: TriageListWindowHostV1 = {
        async executeAction(_action, rawInput, options) {
            fixture.setScan(async (_operation, _input, scanOptions) => {
                if (held) scanState.signal = scanOptions?.signal;
                if (held) await held;
                return { kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [{
                    kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId },
                    locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
                }] };
            });
            return fixture.readEntries(TriageListEntriesInputV1Schema.parse(rawInput), options);
        },
    };
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('daemon-a');
    const lease = acquireTriageListWindow(host, scope);
    try {
        await refreshTriageListWindow('view', host, scope);
        const store = readTriageListWindowReadOwner(host, scope)!;
        expect(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).toEqual(['baseline']);
        const published = vi.fn();
        store.subscribe(published);
        held = new Promise<void>(resolve => { release = resolve; });
        entryId = 'late-row';
        const pending = refreshTriageListWindow('manual', host, scope);
        await vi.waitFor(() => expect(scanState.signal).toBeDefined());
        lifetime.retire();
        published.mockClear();
        release();
        await pending;
        expect.soft(published).not.toHaveBeenCalled();
        expect.soft(store.getSnapshot().window?.rows.map(row => row.entryRef.entryId)).not.toContain('late-row');
        expect.soft(store.getRow(triageEntryRowKey({ source, kindId: 'pull-request', collisionScope: 'example/repository', entryId: 'late-row' }))).toBeNull();
        expect.soft(fixture.durableWriteAttempts).toEqual([]);
    } finally {
        release();
        lease.release();
        lifetime.retire();
    }
});
