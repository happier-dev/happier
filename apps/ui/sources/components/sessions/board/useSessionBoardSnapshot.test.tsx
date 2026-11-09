import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSystemRecordStoredSchema} from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { act, createDeferred, renderHook } from '@/dev/testkit';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { useSessionBoardSnapshot } = await import('./useSessionBoardSnapshot');
const { useSessionSurfaceItem } = await import('@/sync/domains/session/board/useSessionSurfaceItem');

const sessionId = 'record-observer-refresh';
const detailPath = `/v2/sessions/${sessionId}?accessProjectionVersion=1`;
const coldDetailPath = `/v2/sessions/${sessionId}`;
const recordsPath = `/v2/sessions/${sessionId}/system-records`;
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
function storedItem(itemId: string, title: string, itemRevision = revision) {
    return SessionSystemRecordStoredSchema.parse({ id: itemId,
        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId },
        revision: itemRevision,
        content: { t: 'plain', v: { v: 1, destination: 'transcript', title, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: title } } } } },
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
}

describe('Session record observer refresh authority', () => {
    beforeEach(async () => { await homes.reset(); });
    afterEach(async () => { await homes.reset(); });

    it('preserves a transient Session acquisition failure and recovers on the next demand', async () => {
        const serverId = await homes.addHome({ name: 'Cold acquisition', serverUrl: 'https://cold-records.example.test', accountId: 'alice' });
        let failedRead = false;
        homes.answer(serverId, coldDetailPath, { select: () => {
            failedRead = true;
            return { status: 503, body: { error: 'unavailable' } };
        } });
        const { sync } = await import('@/sync/sync');
        const address = { serverId, sessionId };
        const result = await sync.withSessionSystemRecordRuntime(address, async runtime => runtime.session.id);
        expect(failedRead).toBe(true);
        expect(result).toEqual({ status: 'server_error', retryable: true });
        homes.answer(serverId, coldDetailPath, { body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, serverId })) });
        await expect(sync.withSessionSystemRecordRuntime(address, async runtime => runtime.session.id))
            .resolves.toEqual({ status: 'ok', value: sessionId });
    });

    it('lets item Retry supersede a held Session response body before any record authority exists', async () => {
        const serverId = await homes.addHome({ name: 'Cold Retry', serverUrl: 'https://cold-record-retry.example.test', accountId: 'alice' });
        const held = createDeferred<void>();
        let heldSignal: AbortSignal | null | undefined;
        let bodyStarted = false;
        const session = createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, serverId }));
        homes.answer(serverId, coldDetailPath, { select: (_input, request) => {
            bodyStarted = true;
            heldSignal = request.signal;
            return { body: session, bodyAfter: held.promise };
        } });
        const itemPath = `${recordsPath}/record?owner=host&namespace=surface&kind=item.v1&localId=first`;
        homes.answer(serverId, itemPath, { body: { record: storedItem('first', 'Recovered') } });
        const hook = await renderHook(() => useSessionSurfaceItem({ serverId, sessionId, itemId: 'first', enabled: true }));
        try {
            await waitForHomeGovernance(() => expect(bodyStarted).toBe(true));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', loading: 'initial' });
            homes.answer(serverId, coldDetailPath, { body: session });
            await act(async () => { hook.getCurrent().refresh(); });
            await waitForHomeGovernance(() => {
                expect(heldSignal?.aborted).toBe(true);
                expect(hook.getCurrent()).toMatchObject({ status: 'ready', item: { state: { kind: 'ready', item: { title: 'Recovered' } } } });
            });
            expect(homes.requests.filter(request => request.method === 'GET' && request.path.split('?')[0] === coldDetailPath)).toHaveLength(2);
            expect(homes.requestsFor(itemPath)).toHaveLength(1);
        } finally { held.resolve(); await hook.unmount(); }
    });

    it('preserves superseded Session material as recoverable until a current publication satisfies the next demand', async () => {
        const serverId = await homes.addHome({ name: 'Superseded acquisition', serverUrl: 'https://superseded-records.example.test', accountId: 'alice' });
        const fixture = createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, serverId }));
        homes.answer(serverId, coldDetailPath, { body: fixture });
        const { sync } = await import('@/sync/sync');
        const { storage } = await import('@/sync/domains/state/storage');
        const address = { serverId, sessionId };
        await expect(sync.withSessionSystemRecordRuntime(address, async runtime => runtime.session.id))
            .resolves.toEqual({ status: 'ok', value: sessionId });
        const row = storage.getState().sessionListRowsByServerId[serverId][sessionId];
        storage.getState().mergeSessionListRowsForServerScope(serverId, [{ ...row, metadataVersion: row.metadataVersion + 1 }]);
        await expect(sync.withSessionSystemRecordRuntime(address, async runtime => runtime.session.id, { forceSessionRefresh: true }))
            .resolves.toEqual({ status: 'server_error', retryable: true });
        homes.answer(serverId, coldDetailPath, { body: { ...fixture, session: { ...fixture.session, metadataVersion: row.metadataVersion + 1 } } });
        await expect(sync.withSessionSystemRecordRuntime(address, async runtime => runtime.session.id))
            .resolves.toEqual({ status: 'ok', value: sessionId });
    });

    it('uses only the exact Session held authority for Board demand and preserves next-request denial and Account retirement', async () => {
        const serverId = await homes.addHome({ name: 'Held authority', serverUrl: 'https://held-record-authority.example.test', accountId: 'alice' });
        const otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-record-authority.example.test', accountId: 'alice' });
        homes.answer(serverId, coldDetailPath, { body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, serverId })) });
        const itemPath = `${recordsPath}/record?owner=host&namespace=surface&kind=item.v1&localId=first`;
        const listPath = `${recordsPath}?owner=host&namespace=surface`;
        homes.answer(serverId, itemPath, { body: { record: storedItem('first', 'Held visual') } });
        homes.answer(serverId, listPath, { body: { records: [storedItem('first', 'Held visual')], nextCursor: null, hasNext: false } });
        const item = await renderHook(() => useSessionSurfaceItem({ serverId, sessionId, itemId: 'first', enabled: true }));
        await waitForHomeGovernance(() => expect(item.getCurrent()).toMatchObject({ status: 'ready', item: { state: { kind: 'ready' } } }));
        await item.unmount();
        const { sync } = await import('@/sync/sync');
        const detailReads = () => homes.requests.filter(request => request.path.split('?')[0] === coldDetailPath);
        const reads = detailReads().length;
        homes.answer(serverId, coldDetailPath, { status: 503, body: { error: 'unavailable' } });
        const board = await renderHook(() => useSessionBoardSnapshot({ serverId, sessionId, boardFeatureEnabled: true }));
        try {
            await waitForHomeGovernance(() => expect(board.getCurrent()).toMatchObject({ status: 'ready', snapshot: { loading: 'idle', incomplete: false } }));
            expect(detailReads()).toHaveLength(reads);
            expect(sync.readSessionSystemRecordObservation({ serverId, sessionId: 'foreign-session' })).toBeNull();
            expect(sync.readSessionSystemRecordObservation({ serverId: otherHome, sessionId })).toBeNull();
            homes.answer(otherHome, coldDetailPath, { status: 403, body: { error: 'denied' } });
            const foreign = await renderHook(() => useSessionBoardSnapshot({ serverId: otherHome, sessionId, boardFeatureEnabled: true }));
            try {
                await waitForHomeGovernance(() => expect(foreign.getCurrent()).toMatchObject({ status: 'unavailable', reason: 'forbidden' }));
                expect(homes.requestsFor(listPath).filter(request => request.serverId === otherHome)).toHaveLength(0);
            } finally { await foreign.unmount(); }
            homes.answer(serverId, listPath, { status: 403, body: { error: 'denied', code: 'plugin_session_record_forbidden' } });
            await act(async () => { board.getCurrent().refresh(); });
            await waitForHomeGovernance(() => expect(board.getCurrent()).toMatchObject({ status: 'unavailable', reason: 'forbidden' }));
            expect(sync.readSessionSystemRecordObservation({ serverId, sessionId })?.readCapabilities()?.readTranscript).toBe(true);
            const previousAuthority = sync.readSessionSystemRecordObservation({ serverId, sessionId });
            await act(async () => { await homes.switchAccount(serverId, 'bob'); });
            expect(previousAuthority?.isCurrent()).toBe(false);
            expect(sync.readSessionSystemRecordObservation({ serverId, sessionId })?.scope.accountId).not.toBe('alice');
        } finally { await board.unmount(); }
    });

    it('refreshes the Board and demanded items without rereading Session authority, delivers changes and retires denied content', async () => {
        const serverId = await homes.addHome({ name: 'Observer refresh', serverUrl: 'https://observer-refresh.example.test', accountId: 'alice' });
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        homes.answer(serverId, detailPath, { body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, serverId })) });
        const ids = ['first', 'second', 'third'];
        let changed = false;
        let denied = false;
        const records = () => ids.map(id => storedItem(id, changed && id === 'second' ? 'Changed' : id,
            changed && id === 'second' ? 'ssr1.AAAACHN5c3JlY18xAAAAAg' : revision));
        homes.answer(serverId, `${recordsPath}?owner=host&namespace=surface`, { select: () => denied
            ? { status: 403, body: { error: 'denied', code: 'plugin_session_record_forbidden' } }
            : { body: { records: records(), nextCursor: null, hasNext: false } } });
        for (const id of ids) homes.answer(serverId, `${recordsPath}/record?owner=host&namespace=surface&kind=item.v1&localId=${id}`, {
            select: () => denied ? { status: 403, body: { error: 'denied', code: 'plugin_session_record_forbidden' } }
                : { body: { record: records().find(record => record.id === id) } },
        });
        const hook = await renderHook(() => ({
            board: useSessionBoardSnapshot({ serverId, sessionId, boardFeatureEnabled: true }),
            first: useSessionSurfaceItem({ serverId, sessionId, itemId: 'first', enabled: true }),
            second: useSessionSurfaceItem({ serverId, sessionId, itemId: 'second', enabled: true }),
            third: useSessionSurfaceItem({ serverId, sessionId, itemId: 'third', enabled: true }),
        }));
        try {
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().board).toMatchObject({ status: 'ready', snapshot: { loading: 'idle', incomplete: false } });
                expect(hook.getCurrent().second).toMatchObject({ status: 'ready', item: { state: { kind: 'ready', item: { title: 'second' } } } });
            });
            const sessionReads = homes.requestsFor(detailPath).length;
            expect(sessionReads).toBeGreaterThan(0);
            changed = true;
            await act(async () => { hook.getCurrent().board.refresh(); });
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().second).toMatchObject({ status: 'ready', item: { state: { kind: 'ready', item: { title: 'Changed' } } } });
                expect(hook.getCurrent().board).toMatchObject({ status: 'ready', snapshot: { loading: 'idle', freshness: 'fresh' } });
            });
            expect(homes.requestsFor(detailPath)).toHaveLength(sessionReads);
            const heldBody = createDeferred<void>();
            let heldSignal: AbortSignal | null | undefined;
            let bodyReadStarted = false;
            const secondPath = `${recordsPath}/record?owner=host&namespace=surface&kind=item.v1&localId=second`;
            homes.answer(serverId, secondPath, { select: (_input, request) => {
                bodyReadStarted = true;
                heldSignal = request.signal;
                return { body: { record: storedItem('second', 'Late stale content') }, bodyAfter: heldBody.promise };
            } });
            await act(async () => { hook.getCurrent().second.refresh(); });
            await waitForHomeGovernance(() => expect(bodyReadStarted).toBe(true));
            homes.answer(serverId, secondPath, { body: { record: storedItem('second', 'Retry replacement', 'ssr1.AAAACHN5c3JlY18xAAAAAw') } });
            await act(async () => { hook.getCurrent().second.refresh(); });
            try {
                await waitForHomeGovernance(() => {
                    expect(heldSignal?.aborted).toBe(true);
                    expect(hook.getCurrent().second).toMatchObject({ status: 'ready', item: { state: { kind: 'ready', item: { title: 'Retry replacement' } } } });
                });
            } finally { heldBody.resolve(); }
            await act(async () => { await heldBody.promise; });
            expect(hook.getCurrent().second).toMatchObject({ status: 'ready', item: { state: { kind: 'ready', item: { title: 'Retry replacement' } } } });
            expect(homes.requestsFor(detailPath)).toHaveLength(sessionReads);
            denied = true;
            homes.answer(serverId, secondPath, { status: 403, body: { error: 'denied', code: 'plugin_session_record_forbidden' } });
            await act(async () => { hook.getCurrent().board.refresh(); });
            await waitForHomeGovernance(() => {
                for (const binding of Object.values(hook.getCurrent())) expect(binding).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
            });
            expect(homes.requestsFor(detailPath)).toHaveLength(sessionReads);
        } finally { await hook.unmount(); }
    });
});
