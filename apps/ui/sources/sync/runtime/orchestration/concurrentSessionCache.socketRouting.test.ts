import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import * as routes from '@/sync/domains/transfers/runtime/transferRouteCache';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { SESSION_LIST_DOCUMENT_ADMISSION } from '@/sync/domains/session/sessionDocumentAdmission';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));

const h = await createConcurrentCacheNetworkHarness('cache-routing');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

const rows = () => h.storage.getState().sessionListRowsByServerId[h.homeB.id];
const machines = () => h.storage.getState().machineListByServerId[h.homeB.id];
const route = (serverId = h.homeB.id, remoteMachineId = 'machine-b') => ({ serverId, remoteMachineId });

function countMachineSnapshotEntries(calls: readonly (readonly unknown[])[]): number {
    return calls.reduce((count, [entries]) => count + (Array.isArray(entries)
        ? entries.filter(entry => Array.isArray(entry) && entry.length === 2
            && entry[1] && typeof entry[1] === 'object' && 'metadataVersion' in entry[1] && 'daemonStateVersion' in entry[1]
            && entry[0] === entry[1].id).length : 0), 0);
}

function createMachineReadMetadata(id: string): string {
    return encodePlainMachineStoredContent({ ...createMachineFixture().metadata!, displayName: id });
}

describe('concurrent session cache socket routing', () => {
    it.each(['active', 'secondary'] as const)('targets omitted metadata reads by visible demand and coalesces same-tick hints (%s Home)', async mode => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const { readSessionRoleIdV1 } = await import('@happier-dev/protocol/prompts/roles/sessionRolesSnapshot');
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        const { retainVisibleSessionListSurfaces } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const home = mode === 'active' ? h.homeA : h.homeB;
        const homeRows = () => h.storage.getState().sessionListRowsByServerId[home.id];
        const id = mode + '-metadata-hint';
        const initial = createPlainSessionWithDisplayRecordFixture({ id, metadataVersion: 1, updatedAt: 1,
            metadata: { name: 'Before', path: '/repo', host: 'host', machineId: 'machine-b' } });
        const offscreen = createPlainSessionWithDisplayRecordFixture({ id: id + '-offscreen', metadataVersion: 1, updatedAt: 1,
            metadata: { name: 'Offscreen', path: '/hidden', host: 'host' } });
        h.setSessions(home, [initial, offscreen]);
        h.setMachines(home, [h.machine(home)]);
        h.setResponder(async input => {
            const path = new URL(String(input)).pathname;
            return path.endsWith('/messages') ? Response.json({ messages: [], hasMore: false })
                : path.endsWith('/pending') ? Response.json({ pending: [], pendingVersion: 0 }) : null;
        });
        await h.startFocused();
        // Foreground readiness precedes the background inventory. Settle its finite
        // owner before measuring work caused by metadata, rather than bootstrap.
        await getSyncSingleton().refreshSessions();
        if (mode === 'secondary') { await h.start(); await h.refresh(); await h.ready(); }
        let release = () => {};
        let releaseVisible = () => {};
        try {
            releaseVisible = retainVisibleSessionListSurfaces([{ serverId: home.id, sessionId: id }]);
            const documentReads = () => h.requests('/v2/sessions/read-batch');
            const listReads = () => h.httpRequests.filter(request => ['/v2/sessions', '/v2/sessions/active',
                '/v2/sessions/attention', '/v2/sessions/query'].includes(request.url.pathname)).length;
            const before = documentReads().length;
            const listsBefore = listReads();
            const changed = createPlainSessionWithDisplayRecordFixture({ id, metadataVersion: 2, updatedAt: 2,
                metadata: { name: 'After', path: '/new-repo', host: 'host', machineId: 'machine-b',
                    work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, notes: '', sessionRoles: {} } } } });
            h.setSessions(home, [changed, offscreen]);
            h.socket(home).trigger('update', UpdateContainerSchema.parse({ id: 'metadata-hint', seq: 2, createdAt: 2,
                body: { t: 'update-session', id, metadataDocument: 'omitted', metadataLayoutVersion: 1, metadataVersion: 2 } }));
            await vi.waitFor(() => expect(homeRows()?.[id]?.metadata?.name).toBe('After'));
            expect(homeRows()?.[id]?.metadata?.path).toBe('/new-repo');
            expect(h.storage.getState().sessions[id]).toBeUndefined();
            expect(documentReads().slice(before).map(request => JSON.parse(String(request.init?.body)).sessionIds)).toEqual([[id]]);
            expect(listReads()).toBe(listsBefore);

            const latest = createPlainSessionWithDisplayRecordFixture({ id, metadataVersion: 5, updatedAt: 5,
                metadata: { name: 'After burst', path: '/new-repo', host: 'host', machineId: 'machine-b',
                    work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, notes: '', sessionRoles: {} } } } });
            h.setSessions(home, [latest, offscreen]);
            const beforeBurst = documentReads().length;
            for (const version of [3, 4, 5]) h.socket(home).trigger('update', UpdateContainerSchema.parse({
                id: 'metadata-hint-' + version, seq: version, createdAt: version,
                body: { t: 'update-session', id, metadataDocument: 'omitted', metadataLayoutVersion: 1, metadataVersion: version },
            }));
            await vi.waitFor(() => expect(homeRows()?.[id]?.metadata?.name).toBe('After burst'));
            expect(documentReads().slice(beforeBurst).map(request => JSON.parse(String(request.init?.body)).sessionIds)).toEqual([[id]]);
            expect(listReads()).toBe(listsBefore);

            const changedOffscreen = createPlainSessionWithDisplayRecordFixture({ id: offscreen.id, metadataVersion: 2, updatedAt: 6,
                metadata: { name: 'Shown later', path: '/hidden', host: 'host' } });
            h.setSessions(home, [latest, changedOffscreen]);
            const beforeHidden = documentReads().length;
            h.socket(home).trigger('update', UpdateContainerSchema.parse({ id: 'offscreen-hint', seq: 6, createdAt: 6,
                body: { t: 'update-session', id: offscreen.id, metadataDocument: 'omitted', metadataLayoutVersion: 1, metadataVersion: 2 } }));
            // Metadata-only offscreen patches use the existing activity coalescer.
            await vi.waitFor(() => expect(homeRows()?.[offscreen.id]?.[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion).toBe(2), {
                timeout: loadSyncTuning().activityUpdateDebounceMs + 1_000,
            });
            expect(h.storage.getState().sessions[offscreen.id]).toBeUndefined();
            expect(documentReads()).toHaveLength(beforeHidden);
            expect(listReads()).toBe(listsBefore);
            releaseVisible();
            releaseVisible = retainVisibleSessionListSurfaces([{ serverId: home.id, sessionId: offscreen.id }]);
            await getSyncSingleton().hydrateSessionListRows([{ serverId: home.id, sessionId: offscreen.id }]);
            expect(homeRows()?.[offscreen.id]?.metadata?.name).toBe('Shown later');
            expect(documentReads().slice(beforeHidden).map(request => JSON.parse(String(request.init?.body)).sessionIds)).toEqual([[offscreen.id]]);
            expect(listReads()).toBe(listsBefore);
            releaseVisible();
            release = registerSessionRealtimeTranscriptConsumer(id, home.id);
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.metadataVersion).toBe(5));
            expect(readSessionRoleIdV1(readSessionOwnerMetadataView(h.storage.getState().sessions[id]!))).toBe('orchestrator');
            expect(documentReads().length).toBeGreaterThan(before);
        } finally { release(); releaseVisible(); }
    });

    it('pushes a changed role into an open secondary Home Session without a page reload or inventory read', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const { readSessionRoleIdV1 } = await import('@happier-dev/protocol/prompts/roles/sessionRolesSnapshot');
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        const id = 'secondary-role-change';
        const initial = h.session({ id, seq: 1, metadataVersion: 1,
            metadata: { path: '/repo', host: 'host', machineId: 'machine-b' } });
        const unrelated = Array.from({ length: 1000 }, (_, index) => h.session({ id: `role-unrelated-${index}` }));
        h.setSessions(h.homeB, [initial, ...unrelated]);
        h.setMachines(h.homeB, [h.machine(h.homeB, 'machine-b')]);
        h.setResponder(async input => {
            const path = new URL(String(input)).pathname;
            return path.endsWith('/messages') ? Response.json({ messages: [], hasMore: false })
                : path.endsWith('/pending') ? Response.json({ pending: [], pendingVersion: 0 }) : null;
        });
        await h.start();
        // Await the finite inventory owner before the harness's short readiness
        // assertion; this scale-shaped setup can outlast its polling window.
        await h.refresh();
        await h.ready();
        const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        const role = () => readSessionRoleIdV1(readSessionOwnerMetadataView(h.storage.getState().sessions[id]!));
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
            expect(role()).toBeNull();
            const inventoryReads = h.requests('/v2/sessions').length;
            const retained = rows()?.['role-unrelated-999'];
            expect(retained).toBeDefined();
            const changed = h.session({ id, seq: 1, metadataVersion: 2, updatedAt: 2,
                metadata: { path: '/repo', host: 'host', machineId: 'machine-b', work: {
                    sessionRolesV1: { roleId: 'orchestrator', overrides: {}, notes: '', sessionRoles: {} },
                } } });
            h.setSessions(h.homeB, [changed, ...unrelated]);
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'role-written', seq: 2, createdAt: 2,
                body: { t: 'update-session', id, metadataLayoutVersion: 1,
                    metadata: { version: changed.metadataVersion, value: changed.metadata },
                    ownerMetadata: { value: changed.ownerMetadata },
                } }));
            await vi.waitFor(() => expect(role()).toBe('orchestrator'));
            expect(h.requests('/v2/sessions')).toHaveLength(inventoryReads);
            expect(rows()?.['role-unrelated-999']).toBe(retained);
            const cleared = h.session({ id, seq: 1, metadataVersion: 3, updatedAt: 3,
                metadata: { path: '/repo', host: 'host', machineId: 'machine-b' } });
            h.setSessions(h.homeB, [cleared, ...unrelated]);
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'role-cleared', seq: 3, createdAt: 3,
                body: { t: 'update-session', id, metadataLayoutVersion: 1,
                    metadata: { version: cleared.metadataVersion, value: cleared.metadata },
                    ownerMetadata: { value: cleared.ownerMetadata },
                } }));
            await vi.waitFor(() => expect(role()).toBeNull());
            expect(h.requests('/v2/sessions')).toHaveLength(inventoryReads);
            expect(rows()?.['role-unrelated-999']).toBe(retained);
        } finally { release(); }
    });

    it('refreshes a named Machine push without re-reading the fleet census', async () => {
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        let fleet = Array.from({ length: 137 }, (_, index) => h.machine(h.homeB, `machine-${index}`));
        h.setMachines(h.homeB, fleet);
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 1 })]);
        let refuseSelection = false;
        h.setResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v1/machines/read-batch') return null;
            if (refuseSelection) return Response.json({ results: [] });
            return createMachineReadBatchResponseFixture(JSON.parse(String(init?.body)), id => fleet.find(row => row.id === id) ?? null);
        });
        await h.start(); await h.ready();
        const census = h.requests('/v1/machines').length;
        const untouched = machines()?.find(machine => machine.id === 'machine-136');
        // Count actual fleet-map constructions through the secondary composition,
        // not a cheap getMachineSnapshot fixture injected into syncMachines.
        const snapshots = vi.spyOn(Object, 'fromEntries');
        fleet = fleet.map(row => row.id === 'machine-0' ? { ...row, daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 } : row);
        h.setMachines(h.homeB, fleet);
        h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'machine-change', seq: 1, createdAt: 1,
            body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['machine-0'] } }));
        await vi.waitFor(() => expect(machines()?.find(machine => machine.id === 'machine-0')?.daemonStateVersion).toBe(fleet[0]!.daemonStateVersion));
        expect(h.requests('/v1/machines')).toHaveLength(census);
        expect(h.requests('/v1/machines/read-batch').map(request => JSON.parse(String(request.init?.body)).machineIds)).toEqual([['machine-0']]);
        expect(machines()).toHaveLength(137);
        expect(machines()?.find(machine => machine.id === 'machine-136')).toBe(untouched);
        const snapshotEntries = countMachineSnapshotEntries(snapshots.mock.calls);
        snapshots.mockRestore();
        expect(snapshotEntries).toBe(0);
        // A failed exact response must retain its demand for the next real
        // push. Reverting to full-list refresh would hide that lost selection.
        refuseSelection = true;
        fleet = fleet.map(row => row.id === 'machine-1' ? { ...row, daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 } : row);
        h.setMachines(h.homeB, fleet);
        h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'machine-failed', seq: 2, createdAt: 2,
            body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['machine-1'] } }));
        await vi.waitFor(() => expect(h.storage.getState().machineListStatusByServerId[h.homeB.id]).toBe('error'));
        refuseSelection = false;
        fleet = fleet.map(row => row.id === 'machine-2' ? { ...row, daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 } : row);
        h.setMachines(h.homeB, fleet);
        h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'machine-recovered', seq: 3, createdAt: 3,
            body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['machine-2'] } }));
        await vi.waitFor(() => expect(machines()?.find(machine => machine.id === 'machine-2')?.daemonStateVersion).toBe(fleet[2]!.daemonStateVersion));
        expect(machines()?.find(machine => machine.id === 'machine-1')?.daemonStateVersion).toBe(fleet[1]!.daemonStateVersion);
        expect(h.requests('/v1/machines')).toHaveLength(census);
        const finalSelection = h.requests('/v1/machines/read-batch').at(-1);
        expect(JSON.parse(String(finalSelection?.init?.body)).machineIds.sort()).toEqual(['machine-1', 'machine-2']);
    });
    it('hydrates the secondary fleet without constructing a fleet map for each currentness check', async () => {
        const fleet = Array.from({ length: 137 }, (_, index) => h.machine(h.homeB, `snapshot-${index}`));
        h.setMachines(h.homeB, fleet);
        await h.start();
        // Settle the finite startup refresh before readiness and cost measurement.
        await h.refresh();
        await h.ready();
        const changed = fleet.map(row => ({ ...row, metadataVersion: row.metadataVersion + 1,
            metadata: createMachineReadMetadata(row.id), daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 }));
        h.setMachines(h.homeB, changed);
        const snapshots = vi.spyOn(Object, 'fromEntries');
        try {
            await h.refresh();
            expect(machines()).toHaveLength(137);
            expect(machines()?.every(row => row.metadataVersion === 2 && row.metadata?.displayName === row.id)).toBe(true);
            expect(countMachineSnapshotEntries(snapshots.mock.calls)).toBe(0);
        } finally { snapshots.mockRestore(); }

        // The same keyed inventory must observe a real complete-census withdrawal.
        h.setMachines(h.homeB, changed.slice(1));
        await h.refresh();
        expect(machines()).toHaveLength(136);
        expect(machines()?.some(row => row.id === changed[0]!.id)).toBe(false);
        expect(h.storage.getState().machineRecordsByServerId[h.homeB.id]?.[changed[0]!.id]).toBeUndefined();
        for (const row of machines() ?? []) {
            expect(h.storage.getState().machineRecordsByServerId[h.homeB.id]?.[row.id]).toBe(row);
        }

        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        h.setResponder(async input => {
            if (new URL(String(input)).pathname !== '/v1/machines') return null;
            const response = Response.json(changed.slice(1));
            entered.resolve();
            await release.promise;
            return response;
        });
        const loading = h.refresh();
        try {
            await entered.promise;
            h.storage.getState().applyMachines([createMachineFixture({ id: changed[1]!.id,
                metadataVersion: 3, daemonStateVersion: 3, metadata: { ...createMachineFixture().metadata!, displayName: 'Newer' } })],
                false, { sourceServerId: h.homeB.id });
            const newer = machines()?.find(row => row.id === changed[1]!.id);
            release.resolve();
            await loading;
            expect(machines()?.find(row => row.id === changed[1]!.id)).toBe(newer);
            expect(newer?.metadata?.displayName).toBe('Newer');
        } finally { release.resolve(); await loading; }
    });
    it('publishes secondary Machine names before held daemon content without resurrecting withdrawn or superseded rows', async () => {
        const secret = new Uint8Array(32).fill(83);
        const credentials = { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') };
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, { credentials, encryptionMode: 'e2ee' });
        const writer = await Encryption.create(secret);
        writer.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const fleet = await Promise.all(Array.from({ length: 137 }, async (_, index) => {
            const id = `progressive-${index}`;
            const key = new Uint8Array(32).fill(index + 1);
            await writer.initializeMachines(new Map([[id, key]]));
            const cipher = writer.getMachineEncryption(id)!;
            const row = h.machine(h.homeB, id);
            return { ...row, metadataVersion: 2, daemonStateVersion: 2,
                metadata: await cipher.encryptMetadata({ ...createMachineFixture().metadata!, displayName: id }),
                daemonState: await cipher.encryptDaemonState({ status: 'running', pid: index + 1 }),
                dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(key)),
                access: { ...row.access!, resourceMode: 'e2ee' as const } };
        }));
        h.setMachines(h.homeB, fleet);
        h.setResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret })) : null);
        const encryption = await resolveScopedAccountEncryption({ serverId: h.homeB.id, serverUrl: h.homeB.serverUrl, credentials });
        if (!encryption) throw new Error('Expected the encrypted Home material owner');
        const release = createDeferred<void>();
        const daemonEntered = createDeferred<void>();
        const worker = createFakeCryptoWorker();
        // Native crypto is the boundary. The real encryption/context owners and
        // secondary Home composition remain in the path under this held result.
        encryption.configureNativeCryptoWorker({ routing: { mode: 'require', minPayloadBytes: 0 }, worker: {
            ...worker, decryptAesGcmJson: async request => {
                const result = await worker.decryptAesGcmJson(request);
                if (result.items.some(item => item && typeof item === 'object' && 'status' in item)) {
                    daemonEntered.resolve();
                    await release.promise;
                }
                return result;
            },
        } });
        const snapshots = vi.spyOn(Object, 'fromEntries');
        let loading: Promise<unknown> | undefined;
        try {
            await h.start();
            loading = h.refresh();
            await daemonEntered.promise;
            // A native batch can contain the final metadata result alongside
            // held daemon results. Completed metadata must still publish before
            // that batch settles; full name coverage is checked after release.
            await vi.waitFor(() => expect(machines()?.find(row => row.id === 'progressive-0')?.metadata?.displayName).toBe('progressive-0'));
            expect(machines()?.find(row => row.id === 'progressive-1')?.metadata?.displayName).toBe('progressive-1');
            expect(machines()?.every(row => row.daemonStateVersion === 0 && row.daemonState === null)).toBe(true);
            const retained = machines()!.slice(1);
            h.storage.getState().applyMachines(retained.map(row => row.id === 'progressive-1'
                ? { ...row, metadataVersion: 3, daemonStateVersion: 3,
                    metadata: { ...row.metadata!, displayName: 'Newer' }, daemonState: { status: 'running', pid: 999 },
                    availability: { kind: 'available' as const } } : row),
                true, { sourceServerId: h.homeB.id });
            // Explicit Refresh can queue a successor behind the initial read.
            // Its fresh census must reflect the same genuine withdrawal.
            h.setMachines(h.homeB, fleet.slice(1));
            const newer = machines()!.find(row => row.id === 'progressive-1');
            release.resolve();
            await loading;
            expect(machines()?.some(row => row.id === 'progressive-0')).toBe(false);
            expect(machines()?.find(row => row.id === 'progressive-1')).toBe(newer);
            expect(newer?.metadata?.displayName).toBe('Newer');
            expect(machines()?.filter(row => row.metadata?.displayName === row.id)).toHaveLength(135);
            expect(machines()?.find(row => row.id === 'progressive-136')?.daemonState).toMatchObject({ pid: 137 });
            expect(countMachineSnapshotEntries(snapshots.mock.calls)).toBe(0);
        } finally {
            release.resolve();
            await loading;
            snapshots.mockRestore();
            encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        }
    });
    it('consumes ongoing secondary Home bodies and stream checkpoints through the real Sync owner without hydrating foreign same-id transcripts', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        const id = 'secondary-live';
        h.setSessions(h.homeB, [h.session({ id, metadata: { path: '/repo', host: 'host', machineId: 'machine-b' } })]);
        h.setMachines(h.homeB, [h.machine(h.homeB, 'machine-b')]);
        h.setSessions(h.homeA, [h.session({ id, metadata: { path: '/foreign', host: 'host', machineId: 'machine-a' } })]);
        h.setResponder(async input => {
            const path = new URL(String(input)).pathname;
            return path.endsWith('/messages') ? Response.json({ messages: [], hasMore: false })
                : path.endsWith('/pending') ? Response.json({ pending: [], pendingVersion: 0 }) : null;
        });
        await h.start(); await h.ready();
        const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(message => message.kind === 'agent-text' ? [message.text] : []);
        const record = (text: string) => ({ role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: text } } });
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
            const shellReads = h.requests(`/v2/sessions/${id}`).length;
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-full', seq: 1, createdAt: 2,
                body: { t: 'new-message', sid: id, delivery: 'full', message: { id: 'message-live', seq: 1, localId: null,
                    createdAt: 2, updatedAt: 2, content: { t: 'plain', v: record('secondary durable text') } } } }));
            await vi.waitFor(() => expect(texts()).toContain('secondary durable text'));
            h.socket().trigger('ephemeral', { type: 'transcript-stream-segment', sessionId: id,
                message: { localId: 'stream-live', messageRole: 'agent', tick: 1, createdAt: 3, updatedAt: 3,
                    content: { t: 'plain', v: { ...record('secondary streaming text'), meta: { happierStreamSegmentV1: {
                        v: 1, segmentKind: 'assistant', segmentLocalId: 'stream-live', segmentState: 'streaming', startedAtMs: 3, updatedAtMs: 3,
                    } } } } } });
            await vi.waitFor(() => expect(texts()).toContain('secondary streaming text'));
            expect(h.requests(`/v2/sessions/${id}`).length).toBe(shellReads);
            const secondarySession = h.storage.getState().sessions[id];
            if (!secondarySession) throw new Error('Expected the opened secondary carrier');
            h.storage.getState().applySessions([{ ...secondarySession, serverId: h.homeA.id,
                metadata: { ...secondarySession.metadata, path: '/foreign', host: 'host', machineId: 'machine-a' },
            }]);
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeA.id);
            const foreignMessages = h.storage.getState().sessionMessages[id];
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-foreign', seq: 2, createdAt: 4,
                body: { t: 'new-message', sid: id, delivery: 'full', message: { id: 'foreign-frame', seq: 2, localId: null,
                    createdAt: 4, updatedAt: 4, content: { t: 'plain', v: record('must stay foreign') } } } }));
            await Promise.resolve(); await Promise.resolve();
            expect(h.storage.getState().sessionMessages[id]).toBe(foreignMessages);
            expect(texts()).not.toContain('must stay foreign');
            release();
            const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
            useVoiceTargetStore.setState({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
            const { readMountedSessionRealtimeTranscriptConsumerSessionIds } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(h.homeB.id)).not.toContain(id);
            const { isSessionSurfaceVisible } = await import('@/sync/domains/session/sessionSurfaceVisibility');
            expect(isSessionSurfaceVisible(id, h.homeB.id)).toBe(false);
            const { registerSessionRealtimeScmConsumerScope } = await import('@/sync/runtime/sessionRealtimeScmConsumers');
            const { resolveWorkspaceTargetForSession } = await import('@/sync/domains/session/resolveWorkspaceTargetForSession');
            const { scmDiffCache } = await import('@/scm/diffCache/scmDiffCacheSingleton');
            const releaseScm = registerSessionRealtimeScmConsumerScope({ serverId: h.homeB.id, sessionId: 'scm-surface',
                canonicalProjectKey: 'machine-b:/repo', machineScopeId: 'machine-b', repoRoot: '/repo' });
            const { resolveSessionLiveConsumption, resolveSessionScmMutationSignal } = await import('@/sync/runtime/sessionLiveConsumption');
            expect(resolveSessionLiveConsumption(id, h.homeB.id).isFullContentConsumer).toBe(false);
            expect(resolveSessionScmMutationSignal(id, h.homeB.id)).toBe(true);
            const target = resolveWorkspaceTargetForSession({ serverId: h.homeB.id, sessionId: id });
            if (!target) throw new Error('Expected the admitted secondary workspace target');
            const diffKey = { sessionId: target.workspaceCacheKey, snapshotSignature: 'before-edit', diffArea: 'pending' as const, path: '/repo/file.ts' };
            scmDiffCache.set(diffKey, 'old diff');
            try {
                const editRecord = { role: 'agent', content: { type: 'output', data: {
                    type: 'assistant', uuid: 'edit-record', message: { role: 'assistant', content: [{
                        type: 'tool_use', id: 'edit-tool', name: 'Edit', input: { file_path: '/repo/file.ts', old_string: 'a', new_string: 'b' },
                    }] },
                } } };
                h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-scm-revision', seq: 3, createdAt: 6,
                    body: { t: 'message-updated', sid: id, delivery: 'full', message: { id: 'scm-edit', seq: 1, localId: null,
                        messageRole: 'agent', createdAt: 5, updatedAt: 6, content: { t: 'plain', v: editRecord },
                    } },
                }));
                await vi.waitFor(() => expect(scmDiffCache.get(diffKey)).toBeNull());
                expect(h.storage.getState().sessionMessages[id]).toBe(foreignMessages);
            } finally { releaseScm(); scmDiffCache.invalidateSession(target.workspaceCacheKey); }
        } finally { release(); }
    });

    it('retires the previous Home transcript and watermark when an ACK opens the same id in another Home', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const { captureServerRequestAuthorityForServerAccountScope } = await import('./serverScopedRpc/createServerRequestWithServerScope');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const id = 'same-id-home-switch';
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        h.setSessions(h.homeC, [h.session({ id, seq: 20, metadataVersion: 20,
            metadata: { path: '/old-home', host: 'old-host' } })]);
        h.setSessions(h.homeB, [h.session({ id, seq: 5, metadataVersion: 5,
            metadata: { path: '/new-home', host: 'new-host' } })]);
        const record = (home: string, seq: number) => ({ id: `${home}-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: `${home} text ${seq}` } } } });
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
            if (!url.pathname.endsWith('/messages')) return null;
            const records = url.origin === h.homeC.serverUrl ? [record('old Home', 10), record('old Home', 20)] : [record('new Home', 5)];
            const messages = url.searchParams.has('afterSeq') ? records.filter(row => row.seq > Number(url.searchParams.get('afterSeq')))
                : url.searchParams.has('beforeSeq') ? records.filter(row => row.seq < Number(url.searchParams.get('beforeSeq'))) : records.slice(-1);
            const hasMore = !url.searchParams.has('afterSeq') && messages[0]?.seq === 20;
            return Response.json({ messages, hasMore, nextBeforeSeq: hasMore ? 20 : null });
        });
        await h.start(); await h.ready(); await h.ready(h.homeC);
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(message => message.kind === 'user-text' ? [message.text] : []);
        const releaseOld = registerSessionRealtimeTranscriptConsumer(id, h.homeC.id);
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeC.id);
            expect(texts()).toContain('old Home text 20');
            expect(await getSyncSingleton().loadOlderMessagesFromCursor(id, 20)).toMatchObject({ loaded: 1 });
            expect(texts()).toContain('old Home text 10');
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                serverId: h.homeC.id,
                activeRequest: async () => { throw new Error('Secondary Home read must not use the active transport'); },
            });
            try {
                await getSyncSingleton().ensureSessionVisibleForMessageRoute(id, { serverId: h.homeC.id, forceRefresh: true, authority });
            } finally { await authority.release(); }
            expect(texts()).toContain('old Home text 10');
        } finally { releaseOld(); }
        const { buildSessionMessageObservationFactsV1} = await import('@happier-dev/protocol/sessions');
        h.socket(h.homeC).trigger('update', { id: 'old-home-hidden-revision', seq: 21, createdAt: 21,
            body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1({
                ...record('old Home', 20), updatedAt: 21,
            }) } });
        await Promise.resolve(); await Promise.resolve();
        const releaseNew = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
            await vi.waitFor(() => expect(texts()).toEqual(['new Home text 5']));
            expect(h.storage.getState().sessions[id]?.seq).toBe(5);
            expect(h.storage.getState().sessions[id]?.metadataVersion).toBe(5);
            expect(readSessionOwnerMetadataView(h.storage.getState().sessions[id]!)).toMatchObject({ path: '/new-home', host: 'new-host' });
            const reads = h.requests(`/v1/sessions/${id}/messages`).filter(request => request.url.origin === h.homeB.serverUrl);
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.some(request => Number(request.url.searchParams.get('afterSeq')) > 5
                || Number(request.url.searchParams.get('beforeSeq')) > 6)).toBe(false);
        } finally { releaseNew(); getSyncSingleton().retireLocalSession(id, h.homeB.id); }
    });

    it('opens encrypted secondary Home transcript windows and older pages with the exact Home cipher', async () => {
        const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const id = 'secondary-encrypted-transcript';
        const secret = new Uint8Array(32).fill(71);
        const encryption = await Encryption.create(secret);
        const key = new Uint8Array(32).fill(72);
        await encryption.initializeSessions(new Map([[id, key]]));
        const cipher = encryption.getSessionEncryption(id)!;
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
            credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, encryptionMode: 'e2ee',
        });
        const plain = h.session({ id, seq: 20 });
        if (plain.ownerMetadata?.t !== 'plain') throw new Error('Expected owner metadata fixture');
        const row = { ...plain, encryptionMode: 'e2ee' as const,
            metadata: await cipher.encryptRaw(JSON.parse(plain.metadata)),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                ownerMetadata: plain.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(73) }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
        };
        const message = async (seq: number) => ({ id: `encrypted-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            content: { t: 'encrypted' as const, c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: `secondary text ${seq}` } }) } });
        const older = await message(10);
        let targetRow = await message(20);
        let current = targetRow;
        let heldRead: { started: ReturnType<typeof createDeferred<void>>; gate: ReturnType<typeof createDeferred<void>> } | null = null;
        h.setSessions(h.homeB, [row]);
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.origin !== h.homeB.serverUrl) return null;
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret }));
            if (url.pathname.endsWith('/messages')) {
                const hold = heldRead;
                heldRead = null;
                if (hold) { hold.started.resolve(); await hold.gate.promise; }
                const before = Number(url.searchParams.get('beforeSeq'));
                const after = Number(url.searchParams.get('afterSeq'));
                const records = [older, targetRow, ...(current.id === targetRow.id ? [] : [current])];
                const latest = url.searchParams.has('beforeSeq') ? records.filter(item => item.seq < before).at(-1) : current;
                const messages = url.searchParams.has('afterSeq') ? records.filter(item => item.seq > after) : latest ? [latest] : [];
                const hasMore = !url.searchParams.has('afterSeq') && (messages[0]?.seq ?? 0) > older.seq;
                return Response.json({ messages, hasMore, nextBeforeSeq: hasMore ? messages[0]?.seq : null, nextAfterSeq: null });
            }
            if (url.pathname === `/v2/sessions/${id}`) return Response.json({ session: row });
            if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
            return null;
        });
        await h.start(); await h.refresh();
        expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.listObservation).toMatchObject({ phase: 'ready' });
        expect((await fetchSessionByIdWithServerScope({
            sessionId: id, serverId: h.homeB.id, contentDemand: 'session', activeCredentials: { token: h.homeA.token },
            activeRequest: async () => { throw new Error('Secondary transcript hydration must not use the active Home transport'); },
            activeEncryption: null, sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(), includeTurnsProjection: false,
            getExistingSession: sid => h.storage.getState().sessions[sid],
            applySessions: sessions => h.storage.getState().applySessions(sessions), log: { log() {} },
        })).ok).toBe(true);
        const sync = getSyncSingleton();
        expect(await sync.loadTargetWindowMessages(id, { kind: 'seq', seq: 20 })).toMatchObject({ status: 'loaded', targetPresent: true });
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(item => item.kind === 'user-text' ? [item.text] : []);
        expect(texts()).toContain('secondary text 20');
        expect(await sync.loadOlderMessagesFromCursor(id, 20)).toMatchObject({ loaded: 1 });
        expect(texts()).toContain('secondary text 10');
        expect(h.httpRequests.filter(request => request.url.pathname.endsWith('/messages')).every(request => request.url.origin === h.homeB.serverUrl)).toBe(true);
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { buildSessionMessageObservationFactsV1} = await import('@happier-dev/protocol/sessions');
        const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            current = { ...current, updatedAt: 21, content: { t: 'encrypted', c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: 'secondary revised text 20' } }) } };
            targetRow = current;
            h.socket().trigger('update', { id: 'secondary-encrypted-revision', seq: 2, createdAt: 21,
                body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(current) } });
            await vi.waitFor(() => expect(texts()).toContain('secondary revised text 20'));
            await vi.waitFor(() => expect(h.storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            current = await message(30);
            h.socket().trigger('update', { id: 'secondary-encrypted-append', seq: 3, createdAt: 30,
                body: { t: 'new-message', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(current) } });
            await vi.waitFor(() => expect(texts()).toContain('secondary text 30'));
        } finally { release(); }
        // A hidden edit behind the materialized tail must survive the secondary
        // Home's row-only hint path, then repair when its real demand resumes.
        const { readStaleTranscriptMessageIds } = await import('@/sync/domains/session/realtime/deferredTranscriptState');
        const staleIds = () => readStaleTranscriptMessageIds((sync as unknown as {
            deferredTranscriptState: import('@/sync/domains/session/realtime/deferredTranscriptState').DeferredTranscriptState;
        }).deferredTranscriptState, id);
        targetRow = { ...targetRow, updatedAt: 41, content: { t: 'encrypted', c: await cipher.encryptRaw({
            role: 'user', content: { type: 'text', text: 'secondary edited while hidden' },
        }) } };
        const beforeHiddenEdit = h.httpRequests.filter(request => request.url.pathname.endsWith('/messages')).length;
        h.socket().trigger('update', { id: 'secondary-hidden-revision', seq: 4, createdAt: 41,
            body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(targetRow) } });
        await vi.waitFor(() => expect(staleIds()).toContain(targetRow.id));
        expect(texts()).not.toContain('secondary edited while hidden');
        expect(h.httpRequests.filter(request => request.url.pathname.endsWith('/messages'))).toHaveLength(beforeHiddenEdit);
        const reopen = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            await vi.waitFor(() => expect(texts()).toContain('secondary edited while hidden'));
            expect(texts()).toContain('secondary text 10');
            expect(texts()).toContain('secondary text 30');
        } finally { reopen(); }
        const hold = { started: createDeferred<void>(), gate: createDeferred<void>() };
        heldRead = hold;
        const pending = sync.loadTargetWindowMessages(id, { kind: 'seq', seq: 20 });
        try {
            await hold.started.promise;
            h.storage.getState().applySessions([createSessionFixture({ id, serverId: h.homeA.id })]);
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeA.id);
            const foreignTranscript = h.storage.getState().sessionMessages[id];
            hold.gate.resolve();
            expect((await pending).status).not.toBe('loaded');
            expect(h.storage.getState().sessionMessages[id]).toBe(foreignTranscript);
        } finally { hold.gate.resolve(); await pending; }
    });

    it('refreshes retained secondary Home activity by exact row without Session or Machine census', async () => {
        const id = 'retained-activity';
        h.setSessions(h.homeB, [h.session({ id, seq: 1, updatedAt: 1 }),
            ...Array.from({ length: 40 }, (_, index) => h.session({ id: `unrelated-${index}` }))]);
        await h.start(); await h.ready();
        const before = h.httpRequests.length;
        vi.useFakeTimers();
        try {
            for (let seq = 2; seq <= 4; seq++) {
                h.setSessions(h.homeB, [h.session({ id, seq, updatedAt: seq })]);
                h.socket().trigger('update', { id: `activity-${seq}`, seq, createdAt: seq,
                    body: { t: 'account-change', changeKinds: ['session'], entityIds: [id], sessionSystemRecords: [] } });
                await vi.advanceTimersByTimeAsync(601);
                await vi.waitFor(() => expect(rows()?.[id]?.seq).toBe(seq));
                await h.ready();
            }
            const reads = h.httpRequests.slice(before);
            expect(reads.filter(({ url }) => ['/v2/sessions', '/v2/sessions/active',
                '/v2/sessions/attention', '/v1/machines', '/v1/machines/read-batch'].includes(url.pathname))).toHaveLength(0);
            expect(reads.filter(({ url }) => url.pathname === '/v2/sessions/read-batch')
                .flatMap(({ init }) => JSON.parse(String(init?.body)).sessionIds)).toEqual([id, id, id]);
            expect(rows()?.['unrelated-39']).toBeDefined();
            // A known id alone cannot exclude archive/access changes or legacy writers.
            const beforeArchive = h.httpRequests.length;
            h.setSessions(h.homeB, [h.session({ id, seq: 5, updatedAt: 5, archivedAt: 5 })]);
            h.socket().trigger('update', { id: 'archive-known-row', seq: 5, createdAt: 5,
                body: { t: 'account-change', changeKinds: ['session'], entityIds: [id] } });
            await vi.advanceTimersByTimeAsync(601);
            await h.ready();
            expect(h.httpRequests.slice(beforeArchive).some(({ url }) => url.pathname === '/v2/sessions')).toBe(true);
            expect(rows()?.[id]?.archivedAt).toBe(5);
            for (const wake of [
                { changeKinds: ['session'], entityIds: ['new-row'], sessionSystemRecords: [] },
                { changeKinds: ['session', 'machine'], entityIds: ['new-row', 'machine-b'], sessionSystemRecords: [] },
            ]) {
                const beforeRecovery = h.httpRequests.length;
                h.setSessions(h.homeB, [h.session({ id: 'new-row' })]);
                h.socket().trigger('update', { id: 'conservative-recovery', seq: 6, createdAt: 6,
                    body: { t: 'account-change', ...wake } });
                await vi.advanceTimersByTimeAsync(601);
                await h.ready();
                expect(h.httpRequests.slice(beforeRecovery).some(({ url }) => url.pathname === '/v2/sessions')).toBe(true);
                expect(rows()?.['new-row']).toBeDefined();
            }
        } finally { vi.useRealTimers(); }
    });

    it('reads secondary Home snapshots only for the committed domains that need them', async () => {
        await h.start(); await h.ready();
        const sessionReads = h.requests('/v2/sessions').length;
        const machineReads = h.requests('/v1/machines').length;
        let cursor = 0;
        vi.useFakeTimers();
        try {
            const wake = async (changeKinds: string[] | undefined, entityIds = ['changed-resource']) => {
                h.socket().trigger('update', { id: `secondary-demand-${++cursor}`, seq: cursor, createdAt: 1,
                    body: { t: 'account-change', ...(changeKinds ? { changeKinds } : {}), entityIds } });
                // Drain the incumbent 600ms socket refresh debounce, not a new product budget.
                await vi.advanceTimersByTimeAsync(601);
                await h.ready();
            };
            for (let arrival = 0; arrival < 12; arrival++) await wake(['artifact', 'savedSecretResource']);
            for (let arrival = 0; arrival < 12; arrival++) await wake(['account'], [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1]);
            expect(h.requests('/v2/sessions').length - sessionReads).toBe(0);
            expect(h.requests('/v1/machines').length - machineReads).toBe(0);
            await wake(['machine']);
            expect(h.requests('/v2/sessions').length - sessionReads).toBe(0);
            expect(h.requests('/v1/machines').length - machineReads).toBe(1);
            let expectedSessionReads = 0;
            h.setSessions(h.homeB, [h.session({ id: 'newly-visible-team-session' })]);
            await wake(['account'], [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            expect(h.requests('/v2/sessions').length - sessionReads).toBe(++expectedSessionReads);
            expect(rows()?.['newly-visible-team-session']).toBeDefined();
            for (const kinds of [['session'], ['share'], ['account'], undefined, [], ['future-kind']]) {
                await wake(kinds);
                expect(h.requests('/v2/sessions').length - sessionReads).toBe(++expectedSessionReads);
            }
        } finally { vi.useRealTimers(); }
    });

    it('retains committed wake routing for readers of a secondary Home', async () => {
        const { subscribeHomeAccountChange } = await import('./homeAccountChange');
        const publications: Array<{ serverId: string; changeKinds?: readonly string[]; entityIds?: readonly string[] }> = [];
        const release = subscribeHomeAccountChange(event => { publications.push(event); }, { includeCatchUpPending: true });
        try {
            await h.start(); await h.ready();
            publications.length = 0;
            h.socket().trigger('update', { id: 'secondary-committed-wake', seq: 1, createdAt: 1,
                body: { t: 'account-change', changeKinds: ['session'], entityIds: ['session-b'] } });
            expect(publications).toEqual([expect.objectContaining({
                serverId: h.homeB.id, source: 'socket', changeKinds: ['session'], entityIds: ['session-b'],
            })]);
            const target = { sessionId: 'session-b', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } };
            h.socket().trigger('update', { id: 'secondary-record-wake', seq: 2, createdAt: 1,
                body: { t: 'account-change', changeKinds: ['account'], entityIds: ['session-record:record-b'], sessionSystemRecords: [target] } });
            expect(publications.at(-1)).toMatchObject({ serverId: h.homeB.id, source: 'socket', accountSettingsAffects: true,
                changeKinds: ['account'], entityIds: ['session-record:record-b'], sessionSystemRecords: [target] });
            for (const changeKinds of [['account'], ['future-kind'], [], undefined]) {
                h.socket().trigger('update', { id: 'secondary-coarse-wake', seq: 2, createdAt: 1,
                    body: { t: 'account-change', ...(changeKinds ? { changeKinds } : {}), entityIds: ['unrelated-id'] } });
                expect(publications.at(-1)).toMatchObject({ serverId: h.homeB.id, source: 'socket', accountSettingsAffects: true });
            }
        } finally { release(); }
    });

    it.each(['existing cipher', 'first cipher'] as const)(
        'does not let a retained credential replace the current scoped Account owner (%s)', async initialMaterial => {
            let currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(41) });
            const original = initialMaterial === 'existing cipher'
                ? { token: h.homeB.token, secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') }
                : { token: h.homeB.token };
            await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
                credentials: original, encryptionMode: 'e2ee',
            });
            h.setResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                ? Response.json(currentness)
                : null);
            await h.start(); await h.ready();
            // Hold the existing reconciliation timer at the OS clock boundary.
            // The still-managed Home can receive page demand during rotation.
            vi.useFakeTimers();
            try {
                const replacement = { token: h.homeB.token,
                    secret: encodeBase64(new Uint8Array(32).fill(42), 'base64url') };
                expect(await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl,
                    { serverId: h.homeB.id }, replacement)).toBe(true);
                currentness = { ...createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(42) }),
                    version: 2, updatedAt: 2 };
                const current = await resolveScopedAccountEncryption({ serverId: h.homeB.id,
                    serverUrl: h.homeB.serverUrl, credentials: replacement });
                if (!current) throw new Error('Expected replacement Account material');
                const captured = current.getCurrentEncryptionGenerationScope();
                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);

                // The old entry may fail closed, but must never register its old
                // material again and retire the newly admitted Account owner.
                await Promise.allSettled([h.fetchConcurrentSessionListQueryPage(h.homeB.id, {
                    source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
                    membership: 'rowOnly', signal: new AbortController().signal,
                })]);

                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);
            } finally { vi.useRealTimers(); }
        },
    );

    it('catches demanded Run activity up through the actual concurrent Home reconnect', async () => {
        const { subscribeExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const activeActivity = vi.fn();
        const concurrentActivity = vi.fn();
        const releaseActive = subscribeExecutionRunActivity({ serverId: h.homeA.id, sessionId: 'roster-session' }, activeActivity);
        const releaseConcurrent = subscribeExecutionRunActivity({ serverId: h.homeB.id, sessionId: 'roster-session' }, concurrentActivity);
        try {
            await h.start(); await h.ready();
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            concurrentActivity.mockClear();
            h.socket().trigger('disconnect', 'transport close');
            h.socket().trigger('connect');
            expect(concurrentActivity).toHaveBeenCalledTimes(1);
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            expect(activeActivity).not.toHaveBeenCalled();
        } finally { releaseActive(); releaseConcurrent(); }
    });

    it('keeps shared encrypted content cold while retaining Account-owned names and demanded per-Home metadata', async () => {
        const { createSessionDisplayCrypto } = await import('@/sync/encryption/sessionDisplayCrypto');
        // Observe the real owner so accidental content demand is visible at
        // every batch size, including batches below the Worker threshold.
        const decryptDataKeys = vi.spyOn(Encryption.prototype, 'decryptEncryptionKeys');
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
            credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, encryptionMode: 'e2ee',
        });
        const encryptedRows = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
            const id = 'encrypted-session-' + index;
            const key = new Uint8Array(32).fill(index + 1);
            // 1056e008: unopened missing displays do not demand Session bodies.
            const row = createPlainSessionWithDisplayRecordFixture({ id, active: true, activeAt: 2,
                metadata: { path: '/repo', host: 'test', name: 'Encrypted ' + index } });
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected a Plain fixture to seal');
            const display = row.displayProjectionV1;
            if (display?.shared.t !== 'plain' || display.owner?.t !== 'plain') throw new Error('Expected plain display fixtures to seal');
            await encryption.initializeSessions(new Map([[id, key]]));
            const cipher = encryption.getSessionEncryption(id);
            if (!cipher) throw new Error('Expected the Session fixture cipher');
            const displayCrypto = createSessionDisplayCrypto({ sessionMode: 'e2ee', accountMode: 'e2ee',
                credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, sessionEncryption: cipher });
            return { ...row, encryptionMode: 'e2ee' as const,
                displayProjectionV1: { ...display, shared: await displayCrypto.encodeSharedDisplay(display.shared.v.display),
                    owner: displayCrypto.encodeOwnerDisplay(display.owner.v.display) },
                metadata: await cipher.encryptRaw(JSON.parse(row.metadata)),
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                    ownerMetadata: row.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(index + 3) }),
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            };
        }));
        h.setSessions(h.homeB, encryptedRows);
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.origin !== h.homeB.serverUrl) return null;
            const path = url.pathname;
            if (path === '/v2/sessions/read-batch') return null;
            if (path === '/v1/account/encryption/currentness') return Response.json(
                createLegacyAccountEncryptionCurrentnessFixture({ secret }));
            if (path === '/v2/sessions/active') return Response.json({ sessions: encryptedRows, nextCursor: null, hasNext: false });
            if (path.startsWith('/v2/sessions/')) {
                const row = encryptedRows.find(row => row.id === decodeURIComponent(path.slice('/v2/sessions/'.length)));
                return row ? Response.json({ session: row })
                    : Response.json({ error: 'Session not found' }, { status: 404 });
            }
            return null;
        });
        try {
            await h.start(); await h.ready();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            expect(Object.keys(rows() ?? {})).toEqual(encryptedRows.map(row => row.id));
            for (const row of encryptedRows) {
                // The canonical locked-owner projection admits the Account-encrypted
                // name, but does not open Session-encrypted workspace content.
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + encryptedRows.indexOf(row));
                expect(rows()?.[row.id]?.metadata?.path).toBe('');
                expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.[row.id]).toBeUndefined();
            }
            expect(h.socket().serverUrl).toBe(h.homeB.serverUrl);
            const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
            const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
            const sessionDataKeys = new Map<string, Uint8Array>();
            const sessionDataKeyEnvelopes = new Map<string, string>();
            const readDemandedSession = (sessionId: string) => fetchSessionByIdWithServerScope({
                sessionId, serverId: h.homeB.id, contentDemand: 'session',
                activeCredentials: { token: h.homeA.token },
                activeRequest: h.network.request,
                sessionDataKeys, sessionDataKeyEnvelopes, includeTurnsProjection: false,
                getCurrentSessionListRenderable: id => rows()?.[id],
                applySessions: sessions => h.storage.getState().applyServerScopedSessionListRows(
                    h.homeB.id, sessions.map(session => buildSessionListRenderableFromSession(session, rows()?.[session.id])),
                    { source: 'rowOnly', mode: 'append' },
                ),
                log: { log() {} },
            });
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(encryptedRows.length);
            expect(rows()?.['encrypted-session-0']?.metadata?.name).toBe('Encrypted 0');
            expect(rows()?.['encrypted-session-0']?.metadata?.path).toBe('/repo');
            decryptDataKeys.mockClear();
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            const demandedRows = rows();
            await h.refresh();
            for (const [index, row] of encryptedRows.entries()) {
                expect(rows()?.[row.id]?.metadata).toBe(demandedRows?.[row.id]?.metadata);
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + index);
                expect(rows()?.[row.id]?.encryptedContentAvailability).toBe(demandedRows?.[row.id]?.encryptedContentAvailability);
            }
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            // The first lean refresh binds owner provenance to the concurrent
            // runtime's retained credentials; identical later refreshes reuse it.
            const initialRows = rows();
            await h.refresh();
            expect(rows()).toBe(initialRows);
            for (const row of encryptedRows) expect(rows()?.[row.id]).toBe(initialRows?.[row.id]);
            expect(rows()?.['encrypted-session-4']?.metadata?.name).toBe('Encrypted 4');
            // Observe the current compact-list boundary's actual demanded batch reads.
            expect(h.requests('/v2/sessions/read-batch')
                .filter(request => JSON.parse(String(request.init?.body)).sessionIds.includes('encrypted-session-0'))
                .map(request => request.url.origin))
                .toEqual([h.homeB.serverUrl, h.homeB.serverUrl]);
            expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.['encrypted-session-0']).toBeUndefined();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
        } finally {
            decryptDataKeys.mockRestore();
        }
    });

    it('replaces stale machine entries when an authoritative refresh omits a removed machine', async () => {
        h.setMachines(h.homeB, [h.machine(h.homeB), h.machine(h.homeB, 'removed-machine')]);
        await h.start(); await h.ready();
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b', 'removed-machine']);
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), seq: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(machines()?.[0]?.seq).toBe(2);
    });

    it('invalidates only the non-active Home machine route when daemon state advances', async () => {
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 1 }]);
        await h.start(); await h.ready();
        for (const key of [route(), route(h.homeB.id, 'other-machine'), route(h.homeC.id)]) {
            routes.recordCachedMachineRpcDirectRouteViable(key);
        }
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toMatchObject({ status: 'viable' });
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.[0]?.daemonStateVersion).toBe(2);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeB.id, 'other-machine'))).toMatchObject({ status: 'viable' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('keeps the active machine writer authoritative without withdrawing another Home or Machine route', async () => {
        await h.start(); await h.ready();
        const initial = h.storage.getState();
        h.storage.setState({ profile: { ...initial.profile, id: h.homeA.accountId },
            profileScope: { serverId: h.homeA.id, accountId: h.homeA.accountId } });
        try {
            const machine = createMachineFixture({ id: 'active-machine', daemonStateVersion: 1 });
            const source = { sourceServerId: h.homeA.id, sourceAccountId: h.homeA.accountId };
            h.storage.getState().applyMachines([machine], true, source);
            const active = route(h.homeA.id, machine.id);
            const otherMachine = route(h.homeA.id, 'other-machine');
            const otherHome = route(h.homeB.id, machine.id);
            for (const key of [active, otherMachine, otherHome]) routes.recordCachedMachineRpcDirectRouteViable(key);
            h.storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2 }], true, source);
            expect(h.storage.getState().machines[machine.id]?.daemonStateVersion).toBe(2);
            expect(routes.readCachedMachineRpcDirectRoute(active)).toEqual({ status: 'unknown' });
            expect(routes.readCachedMachineRpcDirectRoute(otherMachine)).toMatchObject({ status: 'viable' });
            expect(routes.readCachedMachineRpcDirectRoute(otherHome)).toMatchObject({ status: 'viable' });
        } finally { h.storage.setState({ profile: initial.profile, profileScope: initial.profileScope }); }
    });

    it('keeps canonical rows stable without copying them into the concurrent Home cache', async () => {
        // Persisted display data is available without demand-only backfill (1056e008).
        h.setSessions(h.homeB, [createPlainSessionWithDisplayRecordFixture({ id: 'session-b',
            metadata: { path: '/repo', host: 'test', name: 'Secondary Session' } })]);
        await h.start(); await h.ready();
        const initialRows = h.storage.getState().sessionListRowsByServerId;
        const projection = h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id];
        expect(rows()?.['session-b']?.metadata?.name).toBe('Secondary Session');
        expect(projection).not.toHaveProperty('sessions');
        expect(projection).not.toHaveProperty('sessionRows');
        await h.refresh();
        expect(h.storage.getState().sessionListRowsByServerId).toBe(initialRows);
        expect(Array.isArray(h.storage.getState().sessionListIndexByServerId[h.homeB.id])).toBe(true);
        expect(h.storage.getState().ordinarySessionListMembershipByServerId[h.homeB.id]).toEqual(['session-b']);
    });

    it('keeps the list index stable when only non-structural Session fields change', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 1, updatedAt: 2000 })]);
        await h.start(); await h.ready();
        const beforeIndex = h.storage.getState().sessionListIndexByServerId[h.homeB.id];
        const beforeRows = rows();
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 2, updatedAt: 3000 })]);
        await h.refresh();
        expect(h.storage.getState().sessionListIndexByServerId[h.homeB.id]).toBe(beforeIndex);
        expect(rows()).not.toBe(beforeRows);
        expect(rows()?.['session-b']?.updatedAt).toBe(3000);
    });

    it('invalidates cached transfer routes when a concurrent Home is removed from the desired set', async () => {
        await h.start(); await h.ready();
        routes.recordCachedMachineRpcDirectRouteViable(route());
        routes.recordCachedMachineRpcDirectRouteViable(route(h.homeC.id));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('isolates concurrent Session and machine refreshes by Home', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        h.setSessions(h.homeC, [h.session({ id: 'session-c' })]);
        h.setMachines(h.homeB, [h.machine(h.homeB)]);
        h.setMachines(h.homeC, [h.machine(h.homeC, 'machine-c')]);
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        expect(Object.keys(rows() ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[h.homeC.id] ?? {})).toEqual(['session-c']);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(h.storage.getState().machineListByServerId[h.homeC.id]?.map(machine => machine.id)).toEqual(['machine-c']);
    });

    it('scopes same-URL alternate persisted profiles by exact Home identity and Account', async () => {
        const identityB = 'srv_same_url_home_b';
        const identityC = 'srv_same_url_home_c';
        const [aProfile, bProfile, cProfile] = [h.homeA, h.homeB, h.homeC].map(home => h.profiles.getServerProfileById(home.id));
        if (!aProfile || !bProfile || !cProfile) throw new Error('Expected the saved Home profiles');
        const b = { ...bProfile, serverIdentityId: identityB, legacyServerIds: [h.homeB.id], canonicalServerUrl: h.homeB.serverUrl };
        const c = { ...cProfile, serverIdentityId: identityC, legacyServerIds: [h.homeC.id],
            serverUrl: h.homeB.serverUrl, canonicalServerUrl: h.homeB.serverUrl };
        const browserStorage = typeof window !== 'undefined' && typeof document !== 'undefined'
            ? window.localStorage : undefined;
        await seedPersistedHomeProfilesForTests({ profiles: [aProfile, b, c], activeServerId: h.homeA.id, browserStorage });
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityB)).toBe(identityB);
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityC)).toBe(identityC);
        expect(await h.TokenStorage.setCredentialsForServerUrl(b.serverUrl, { serverId: identityB }, { token: h.homeB.token })).toBe(true);
        expect(await h.TokenStorage.setCredentialsForServerUrl(c.serverUrl, { serverId: identityC }, { token: h.homeC.token })).toBe(true);
        h.setResponder(async (input, init) => {
            const url = new URL(String(input));
            const isC = new Headers(init?.headers).get('authorization') === 'Bearer ' + h.homeC.token;
            if (url.pathname === '/v2/sessions') return Response.json({ sessions: [h.session({ id: isC ? 'session-c' : 'session-b' })], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines') return Response.json([h.machine(isC ? h.homeC : h.homeB, isC ? 'machine-c' : 'machine-b')]);
            return null;
        });
        await h.select([h.homeA.id, identityB, identityC]);
        h.startConcurrentSessionCacheSync();
        await h.ready({ ...h.homeB, id: identityB }); await h.ready({ ...h.homeC, id: identityC });
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityB] ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityC] ?? {})).toEqual(['session-c']);
        expect(h.storage.getState().sessionListRowsByServerId[b.id]).toBeUndefined();
        expect(h.network.credentialRequests).toEqual(expect.arrayContaining([
            { serverUrl: b.serverUrl, serverId: identityB }, { serverUrl: c.serverUrl, serverId: identityC },
        ]));
    });

    it('clears stale non-active caches when a Home is removed from concurrent selection', async () => {
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        await h.select([h.homeA.id, h.homeB.id]);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeC.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeC.id]).toBeUndefined();
        expect(h.storage.getState().machineRecordsByServerId[h.homeC.id]).toBeUndefined();
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(true);
    });

    it('reconciles a renamed secondary profile without a selection or focus change', async () => {
        await h.start(); await h.ready();
        await h.profiles.adoptHomeProfile({ descriptor: { serverUrl: h.homeB.serverUrl, displayName: 'Renamed B' }, source: 'manual' });
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.serverName).toBe('Renamed B'));
        expect(h.profiles.getActiveServerId()).toBe(h.homeA.id);
    });

    it('stops a secondary transport and clears caches when its profile disappears', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeB.id]).toBeUndefined();
        expect(h.storage.getState().machineRecordsByServerId[h.homeB.id]).toBeUndefined();
        expect(socket.socket.connected).toBe(false);
    });

    it('does not resurrect a stopped cache after its deferred OS credential read settles', async () => {
        const gate = h.holdCredentialRead();
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(gate.started).toBe(true));
        h.stopConcurrentSessionCacheSync();
        gate.release();
        expect(Boolean(await h.TokenStorage.getCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }))).toBe(true);
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
        expect(h.network.socketBoundaries.filter(socket => socket.serverUrl === h.homeB.serverUrl)).toEqual([]);
        expect(rows()).toBeUndefined();
    });

    it('does not publish a stale HTTP snapshot after its Home entry has been retired', async () => {
        let signal: AbortSignal | null | undefined;
        let finish!: () => void;
        h.setResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v2/sessions') return null;
            signal = init?.signal;
            await new Promise<void>(resolve => { finish = resolve; });
            return Response.json({ sessions: [h.session({ id: 'stale-session' })], nextCursor: null, hasNext: false });
        });
        await h.start();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        finish();
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(rows()).toBeUndefined();
        expect(machines()).toBeUndefined();
    });
});
