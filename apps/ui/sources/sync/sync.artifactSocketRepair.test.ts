import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { deriveApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createArtifactReadBatchHttpResponse, createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createDeferred } from '@/dev/testkit';
import { isArtifactInventoryLoaded } from './domains/artifacts/artifactInventory';
import type { Artifact } from './domains/artifacts/artifactTypes';
import type { HomeAccountChangeEvent } from './runtime/orchestration/homeAccountChange';

await initializeArtifactInventoryDemandHarness();

describe('Sync exact socket Artifact repair', () => {
    let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
    beforeEach(async () => { fixture = await createArtifactInventoryDemandHarness(); });
    afterEach(async () => { await fixture?.dispose(); vi.restoreAllMocks(); });

    it('repairs an unknown updated id without recensus of 43331 retained approval receipts', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { decryptArtifactListItems } = await import('./engine/artifacts/syncArtifacts');
        const scope = storage.getState().profileScope!;
        const open = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Exact repair' });
        const closed = ApprovalRequestV1Schema.parse({ ...open, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } });
        const wire = (request: typeof open): Artifact => {
            const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: scope.serverId });
            return { ...fixture.inventory[0]!, kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
                ...deriveApprovalArtifactQueryHintsV1(header), header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) };
        };
        const prototype = (await decryptArtifactListItems({ artifacts: [wire(closed)], encryption: null, artifactDataKeys: new Map() }))[0]!;
        const retained = Array.from({ length: 43_331 }, (_, index) => ({ ...prototype,
            id: `11111111-1111-4111-8111-8${String(index).padStart(11, '0')}` }));
        storage.getState().applyArtifacts(retained);
        const changed = { ...fixture.inventory[0]!, id: '11111111-1111-4111-8111-900000000000', kindHint: 'markdown',
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Exact repair' }), headerVersion: 2 };
        fixture.inventory = [changed];
        const counts = { header: 0, rawHeader: 0, body: 0 };
        for (const row of retained) for (const field of ['header', 'rawHeader', 'body'] as const) {
            const value = row[field];
            Object.defineProperty(row, field, { configurable: true, enumerable: true, get() { counts[field]++; return value; } });
        }
        const release = sync.observeArtifactInventory(scope, 'inboxOpen');
        try {
            expect(isArtifactInventoryLoaded(storage.getState(), 'inboxOpen')).toBe(false);
            const socket = fixture.network.socketBoundaries.find(boundary => boundary.socket.onAny.mock.calls.length > 0);
            expect(socket).toBeDefined();
            fixture.pages.length = 0; fixture.headerReads.length = 0; fixture.bodyReads.length = 0;
            // Socket.IO and HTTP are the genuine boundaries; dispatch, authority,
            // exact repair and the published Zustand projections remain real.
            socket!.trigger('update', { id: 'socket-exact-artifact-repair', seq: 1, createdAt: 3,
                body: { t: 'update-artifact', artifactId: changed.id,
                    header: { version: changed.headerVersion, value: changed.header } } });
            await vi.waitFor(() => expect(fixture.pages.length + fixture.headerReads.length).toBeGreaterThan(0));
            await fixture.settleInventory();
            console.log('Socket Artifact repair cost', JSON.stringify({ counts, pages: fixture.pages,
                headers: fixture.headerReads, bodies: fixture.bodyReads }));
            expect(counts).toEqual({ header: 0, rawHeader: 0, body: 0 });
            expect(fixture.pages).toEqual([]);
            expect(fixture.headerReads).toEqual([[changed.id]]);
            expect(fixture.bodyReads).toEqual([]);
            await vi.waitFor(() => expect(storage.getState().artifacts[changed.id]?.header?.title).toBe('Exact repair'));
            expect(storage.getState().artifacts[retained[0]!.id]).toBe(retained[0]);
            expect(isArtifactInventoryLoaded(storage.getState(), 'inboxOpen')).toBe(false);
        } finally { release(); }
    }, 120_000);

    it('preserves the committed wake and retries a transient exact repair without another push', async () => {
        const { storage } = await import('./domains/state/storage');
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const scope = storage.getState().profileScope!;
        const changed = { ...fixture.inventory[0]!, id: '11111111-1111-4111-8111-900000000001', kindHint: 'markdown',
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Recovered exact repair' }), headerVersion: 2 };
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        boundary.replaceStoredRow(changed);
        let unavailable = true;
        fixture.artifactStore = { ...boundary, handle(path, init) {
            if (path === '/v1/artifacts/read' && unavailable) return Promise.resolve(createArtifactReadBatchHttpResponse(
                JSON.parse(String(init?.body)), artifactId => ({ artifactId, ok: false,
                    error: 'artifact_access_unavailable', status: 500, retryable: true }),
            ));
            return boundary.handle(path, init);
        } };
        const wakes: HomeAccountChangeEvent[] = [];
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (event.entityIds?.includes(changed.id)) wakes.push(event);
        });
        try {
            const socket = fixture.network.socketBoundaries.find(value => value.socket.onAny.mock.calls.length > 0);
            expect(socket).toBeDefined();
            const update = { id: 'socket-artifact-repair-recovery', seq: 1, createdAt: 3,
                body: { t: 'update-artifact', artifactId: changed.id,
                    header: { version: changed.headerVersion, value: changed.header } } };
            fixture.pages.length = 0; fixture.headerReads.length = 0; fixture.bodyReads.length = 0;
            socket!.trigger('update', update);
            await vi.waitFor(() => expect(fixture.headerReads).toEqual([[changed.id]]));
            await vi.waitFor(() => expect(wakes).toHaveLength(1));
            expect(wakes[0]).toMatchObject({ serverId: scope.serverId, changeKinds: ['artifact'], entityIds: [changed.id] });
            expect(storage.getState().artifacts[changed.id]).toBeUndefined();
            unavailable = false;
            await fixture.settleInventory();
            console.log('Socket Artifact autonomous recovery cost', JSON.stringify({ pages: fixture.pages,
                headers: fixture.headerReads, wakes: wakes.length }));
            await vi.waitFor(() => expect(storage.getState().artifacts[changed.id]?.header?.title).toBe('Recovered exact repair'));
            expect(fixture.headerReads).toEqual([[changed.id], [changed.id]]);
            expect(wakes).toHaveLength(1);
            expect(fixture.pages).toEqual([]);
            expect(fixture.bodyReads).toEqual([]);
        } finally { unsubscribe(); }
    });

    it('retains another exact id and a narrow census admitted during an in-flight repair', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const scope = storage.getState().profileScope!;
        const rows = [2, 3].map(index => ({ ...fixture.inventory[0]!,
            id: `11111111-1111-4111-8111-90000000000${index}`, kindHint: 'markdown', headerVersion: 2,
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: `Concurrent repair ${index}` }) }));
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        rows.forEach(row => boundary.replaceStoredRow(row));
        const started = createDeferred<void>(), releaseRead = createDeferred<void>();
        let holdFirst = true;
        fixture.artifactStore = { ...boundary, handle(path, init) {
            const response = boundary.handle(path, init);
            if (path === '/v1/artifacts/read' && holdFirst) {
                holdFirst = false;
                if (!response) throw new Error('Expected the exact Artifact HTTP boundary');
                started.resolve();
                return releaseRead.promise.then(() => response);
            }
            return response;
        } };
        const socket = fixture.network.socketBoundaries.find(value => value.socket.onAny.mock.calls.length > 0);
        expect(socket).toBeDefined();
        const update = (row: Artifact, seq: number) => ({ id: `concurrent-artifact-repair-${seq}`, seq, createdAt: 3,
            body: { t: 'update-artifact', artifactId: row.id, header: { version: row.headerVersion, value: row.header } } });
        let releaseDemand: (() => void) | undefined;
        fixture.pages.length = 0; fixture.headerReads.length = 0;
        try {
            socket!.trigger('update', update(rows[0]!, 1));
            await started.promise;
            socket!.trigger('update', update(rows[1]!, 2));
            releaseDemand = sync.observeArtifactInventory(scope, 'inboxOpen', { refreshOnAdmission: true });
            releaseRead.resolve();
            await fixture.settleInventory();
            await vi.waitFor(() => expect(rows.map(row => storage.getState().artifacts[row.id]?.title))
                .toEqual(['Concurrent repair 2', 'Concurrent repair 3']));
            expect(fixture.headerReads).toEqual([[rows[0]!.id], [rows[1]!.id]]);
            expect(fixture.pages).toHaveLength(1);
            expect(isArtifactInventoryLoaded(storage.getState(), 'inboxOpen')).toBe(true);
        } finally { releaseRead.resolve(); releaseDemand?.(); }
    });

    it('does not carry a failed exact repair into a replacement Account', async () => {
        const { storage } = await import('./domains/state/storage');
        const oldId = '11111111-1111-4111-8111-900000000004';
        const oldSocket = fixture.network.socketBoundaries.find(value => value.socket.onAny.mock.calls.length > 0);
        expect(oldSocket).toBeDefined();
        const scope = storage.getState().profileScope!;
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        fixture.artifactStore = { ...boundary, handle(path, init) {
            if (path === '/v1/artifacts/read') return Promise.resolve(createArtifactReadBatchHttpResponse(
                JSON.parse(String(init?.body)), artifactId => ({ artifactId, ok: false,
                    error: 'artifact_access_unavailable', status: 500, retryable: true }),
            ));
            return boundary.handle(path, init);
        } };
        fixture.headerReads.length = 0;
        oldSocket!.trigger('update', { id: 'old-account-artifact-repair', seq: 1, createdAt: 3,
            body: { t: 'update-artifact', artifactId: oldId } });
        await vi.waitFor(() => expect(fixture.headerReads).toEqual([[oldId]]));
        fixture.artifactStore = null;
        const replacement = { ...fixture.inventory[0]!, id: '11111111-1111-4111-8111-900000000005',
            ownerAccountId: 'replacement-artifact-account', kindHint: 'markdown', headerVersion: 2,
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Replacement Account document' }) };
        fixture.inventory = [replacement];
        fixture.accountId = replacement.ownerAccountId;
        await fixture.network.setAccount('https://artifact-demand.example.test', replacement.ownerAccountId);
        await fixture.settleInventory();
        expect(storage.getState().profileScope?.accountId).toBe(replacement.ownerAccountId);
        expect(fixture.headerReads).toEqual([[oldId]]);
        const socket = fixture.network.socketBoundaries.filter(value => value.socket.onAny.mock.calls.length > 0).at(-1);
        expect(socket).toBeDefined();
        socket!.trigger('update', { id: 'replacement-account-artifact-repair', seq: 2, createdAt: 4,
            body: { t: 'update-artifact', artifactId: replacement.id } });
        await vi.waitFor(() => expect(storage.getState().artifacts[replacement.id]?.title).toBe('Replacement Account document'));
        expect(fixture.headerReads).toEqual([[oldId], [replacement.id]]);
        expect(storage.getState().artifacts[oldId]).toBeUndefined();
    });
});
