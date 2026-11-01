import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createServerFetchWithReachabilityProbe } from '@/dev/testkit/mocks/serverFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { Encryption } from '@/sync/encryption/encryption';
import type { SyncTuning } from '@/sync/runtime/syncTuning';
import type { InvalidateSync } from '@/utils/sessions/sync';
import type { PauseController } from '@/utils/timing/pauseController';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The transport stays disconnected; HTTP, snapshot orchestration, queues and stores run normally.
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(), onError: vi.fn(), onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}), onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(), disconnect: vi.fn(), initialize: vi.fn(),
        request: vi.fn(async (path: string, init?: RequestInit) => fetch(new URL(path, 'http://localhost:53288'), init)),
    },
}));

type SnapshotRuntime = {
    credentials: AuthCredentials | null;
    encryption: Encryption;
    serverID: string;
    changesCursor: string | null;
    lastSocketOfflineDurationMs: number | null;
    syncTuning: SyncTuning;
    pauseController: PauseController;
    sessionsSync: InvalidateSync;
    machinesSync: InvalidateSync;
    fetchSessions: () => Promise<void>;
    getOrCreateMessagesSync: (sessionId: string) => InvalidateSync;
    fetchMachines: () => Promise<void>;
    disconnectServer: () => void;
    snapshotRefreshOnResume: (options: { mode: 'fallback' | 'long-offline'; reason: string }) => Promise<{ status: 'complete' | 'error' }>;
    resumeViaChanges: (options: { accountId: string }) => Promise<unknown>;
};

describe('snapshot refresh completion', () => {
    let runtime: SnapshotRuntime;

    beforeEach(async () => {
        vi.resetModules();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { clearActiveViewingSessionsForServerScopeReset } = await import('@/sync/domains/session/activeViewingSession');
        clearActiveViewingSessionsForServerScopeReset();
        runtime = sync as unknown as SnapshotRuntime;
        runtime.credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0LWFjY291bnQifQ.sig' };
        runtime.encryption = Encryption.createWithoutKeyMaterial();
        runtime.serverID = 'test-account';
        runtime.changesCursor = null;
        storage.setState({ profile: { ...storage.getState().profile, id: 'test-account' } });
    });

    afterEach(() => {
        runtime?.disconnectServer();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('does not checkpoint a missing cursor when the app pauses before snapshot repair starts', async () => {
        const requestedPaths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            requestedPaths.push(url.pathname);
            if (url.pathname === '/v2/cursor') {
                runtime.pauseController.pause('snapshot-test');
                return Response.json({ cursor: 42, changesFloor: 0 });
            }
            if (url.pathname === '/v2/changes') return Response.json({ changes: [], nextCursor: 42 });
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        await runtime.resumeViaChanges({ accountId: 'test-account' });

        expect(runtime.changesCursor).toBeNull();
        expect(requestedPaths).toEqual(['/v2/cursor']);
    });

    it.each(['credentials', 'paused'] as const)('reports an incomplete snapshot when %s prevent it from starting', async (reason) => {
        if (reason === 'credentials') runtime.credentials = null;
        else runtime.pauseController.pause('snapshot-test');

        await expect(runtime.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'test' }))
            .resolves.toEqual({ status: 'error' });
    });

    it('propagates a terminal snapshot request failure without checkpointing the cursor', async () => {
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v2/cursor') return Response.json({ cursor: 42, changesFloor: 0 });
            if (url.pathname === '/v2/session-organization') return Response.json({ snapshot: {
                schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
                tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } });
            if (url.pathname === '/v2/sessions') return Response.json({ error: 'invalid request' }, { status: 400 });
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        await expect(runtime.resumeViaChanges({ accountId: 'test-account' })).rejects.toMatchObject({ canTryAgain: false });

        expect(runtime.changesCursor).toBeNull();
    });

    it('propagates a machine snapshot HTTP failure through its canonical sync command', async () => {
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v1/machines') return Response.json({ error: 'invalid request' }, { status: 400 });
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        await expect(runtime.fetchMachines()).rejects.toThrow();
    });

    it('checkpoints a missing cursor after the real snapshot commands complete successfully', async () => {
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const requestedPaths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            requestedPaths.push(url.pathname);
            if (url.pathname === '/v2/cursor') return Response.json({ cursor: 42, changesFloor: 0 });
            if (url.pathname === '/v2/changes') return Response.json({ changes: [], nextCursor: 42 });
            if (url.pathname === '/v2/session-organization') return Response.json({ snapshot: {
                schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
                tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } });
            if (url.pathname === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false, includedActive: true });
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/artifacts' || url.pathname === '/v2/automations') return Response.json([]);
            if (url.pathname === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (url.pathname === '/v1/kv') return Response.json({ items: [] });
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'test-account' });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 0 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { automations: { enabled: false }, social: { friends: { enabled: false } } },
            }));
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        await runtime.resumeViaChanges({ accountId: 'test-account' });

        expect(runtime.changesCursor, JSON.stringify([...new Set(requestedPaths)])).toBe('42');
        expect(requestedPaths).toContain('/v2/changes');
    });

    it.each(['readable', 'held', 'unusable'] as const)('proves already-returned newly required rows before snapshot success: %s', async (scenario) => {
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const serverId = getActiveServerSnapshot().serverId!;
        const organization = {
            schemaVersion: 1 as const, version: 1, pins: [], folders: [], folderAssignments: [],
            tags: [], tagAssignments: [], orderEntries: [], labels: [],
        };
        storage.getState().applySessionOrganizationSnapshot(serverId, organization);
        const organizationReady = createDeferred<void>();
        const hydrationReady = createDeferred<void>();
        const ids = ['new-pin', 'new-standing'];
        const rows = ids.map((id) => ({
            id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, archivedAt: null,
            encryptionMode: 'plain', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
            metadata: JSON.stringify({ path: '/workspace', host: 'test' }),
        }));
        const requiredReads: string[][] = [];
        let settled = false;
        runtime.syncTuning = { ...runtime.syncTuning, invalidateSyncAwaitTimeoutMs: scenario === 'unusable' ? 250 : 5000 };
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v2/cursor') return Response.json({ cursor: 42, changesFloor: 0 });
            if (url.pathname === '/v2/changes') return Response.json({ changes: [], nextCursor: 42 });
            if (url.pathname === '/v2/session-organization') {
                await organizationReady.promise;
                return Response.json({ snapshot: { ...organization, version: 2,
                    pins: [{ sessionId: ids[0], sortKey: 'a', pinnedAt: 1 }],
                    attentionStandings: [{ sessionId: ids[1], standing: true, updatedAt: 1 }],
                } });
            }
            if (url.pathname === '/v2/sessions') {
                if (url.searchParams.get('requiredOnly') === 'true') {
                    requiredReads.push(JSON.parse(url.searchParams.get('requiredSessionIds')!));
                    await hydrationReady.promise;
                }
                return Response.json({ sessions: rows.map((row) => ({ ...row,
                    metadata: scenario === 'readable' || (scenario === 'held' && url.searchParams.get('requiredOnly') === 'true')
                        ? row.metadata : 'invalid-json',
                })), nextCursor: null, hasNext: false, includedActive: true });
            }
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/artifacts' || url.pathname === '/v2/automations') return Response.json([]);
            if (url.pathname === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (url.pathname === '/v1/kv') return Response.json({ items: [] });
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'test-account' });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 0 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { automations: { enabled: false }, social: { friends: { enabled: false } } },
            }));
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const pending = runtime.resumeViaChanges({ accountId: 'test-account' }).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(ids.every((id) => storage.getState().sessionListRenderables[id])).toBe(true));
            expect(settled).toBe(false);
            expect(runtime.changesCursor).toBeNull();
            organizationReady.resolve(undefined);
            if (scenario !== 'readable') {
                await vi.waitFor(() => expect(settled || requiredReads.length > 0).toBe(true));
                expect(runtime.changesCursor).toBeNull();
                expect(settled).toBe(false);
                expect(requiredReads).toEqual([ids]);
            }
            hydrationReady.resolve(undefined);
            await pending;
            expect(runtime.changesCursor).toBe(scenario === 'unusable' ? null : '42');
            if (scenario !== 'unusable') {
                for (const id of ids) expect(storage.getState().sessionListRenderables[id]?.metadata).toMatchObject({ path: '/workspace' });
            }
            expect(requiredReads).toEqual([ids]);
        } finally {
            organizationReady.resolve(undefined);
            hydrationReady.resolve(undefined);
            runtime.sessionsSync.stop();
            await pending;
        }
    });

    it.each([
        { trigger: 'missing-cursor', owner: 'sessionsSync' },
        { trigger: 'missing-cursor', owner: 'fetchSessions' },
        { trigger: 'cursor-gone', owner: 'sessionsSync' },
        { trigger: 'forced-snapshot', owner: 'sessionsSync' },
        { trigger: 'page-budget', owner: 'sessionsSync' },
        { trigger: 'missing-cursor', owner: 'machinesSync' },
        { trigger: 'missing-cursor', owner: 'messagesSync' },
    ] as const)('repairs $trigger with a read started after capture when $owner already has an older read', async ({ trigger, owner }) => {
        const { storage } = await import('./domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol');
        const firstRead = createDeferred<void>();
        const freshRead = createDeferred<void>();
        const captured = createDeferred<void>();
        let serverRevision = 1;
        let reads = 0;
        let settled = false;
        const revisionsAtChangesRead: Array<number | undefined> = [];
        const readMaterializedRevision = () => {
            if (owner === 'machinesSync') return storage.getState().machines.m1?.metadataVersion;
            if (owner === 'messagesSync') {
                const messages = storage.getState().sessionMessages.s1?.reducerState.messageIds;
                return messages?.has('m2') ? 2 : messages?.has('m1') ? 1 : undefined;
            }
            return storage.getState().sessionListRenderables.s1?.metadataVersion;
        };
        const readRevision = async () => {
            const revision = serverRevision;
            reads += 1;
            await (reads === 1 ? firstRead.promise : freshRead.promise);
            return revision;
        };
        runtime.changesCursor = trigger === 'missing-cursor' ? null : '9';
        if (trigger === 'forced-snapshot') {
            runtime.lastSocketOfflineDurationMs = runtime.syncTuning.messageForceSnapshotOfflineMs;
        }
        if (trigger === 'page-budget') {
            runtime.syncTuning = { ...runtime.syncTuning, changesPageLimit: 1, changesMaxPagesPerResume: 1 };
        }
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v2/cursor') {
                captured.resolve(undefined);
                return Response.json({ cursor: 11, changesFloor: 0 });
            }
            if (url.pathname === '/v2/changes') {
                if (url.searchParams.get('after') === '9') {
                    if (trigger === 'cursor-gone') return Response.json({ error: 'cursor-gone', currentCursor: 11 }, { status: 410 });
                    if (trigger === 'page-budget') return Response.json({ changes: [{ cursor: 10, kind: 'artifact', entityId: 'a1', changedAt: 1 }], nextCursor: 10 });
                    return Response.json({ changes: [], nextCursor: 9 });
                }
                revisionsAtChangesRead.push(readMaterializedRevision());
                return Response.json({ changes: [], nextCursor: 11 });
            }
            if (url.pathname === '/v2/sessions') {
                const revision = owner === 'machinesSync' || owner === 'messagesSync' ? serverRevision : await readRevision();
                return Response.json({ sessions: [{
                    id: 's1', seq: owner === 'messagesSync' ? 2 : 0, createdAt: 1, updatedAt: revision, active: false, activeAt: 1,
                    archivedAt: null, encryptionMode: 'plain',
                    metadata: JSON.stringify({ path: '/workspace', host: 'test', name: `revision-${revision}` }),
                    metadataVersion: revision, agentState: null, agentStateVersion: 0,
                    dataEncryptionKey: null,
                }], nextCursor: null, hasNext: false, includedActive: true });
            }
            if (url.pathname === '/v1/machines' && owner === 'machinesSync') {
                const revision = await readRevision();
                const machine = createMachineFixture({ id: 'm1', metadataVersion: revision });
                return Response.json([{ ...machine,
                    metadata: encodePlainMachineStoredContent(machine.metadata),
                    daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }]);
            }
            if (url.pathname === '/v1/sessions/s1/messages') {
                const revision = await readRevision();
                return Response.json({ messages: [{
                    id: `m${revision}`, seq: revision, localId: null, createdAt: revision,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `revision-${revision}` } } },
                }], nextAfterSeq: null });
            }
            if (url.pathname === '/v2/session-organization') return Response.json({ snapshot: {
                schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
                tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/artifacts' || url.pathname === '/v2/automations') return Response.json([]);
            if (url.pathname === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (url.pathname === '/v1/kv') return Response.json({ items: [] });
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'test-account' });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 0 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { automations: { enabled: false }, social: { friends: { enabled: false } } },
            }));
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        const { markSessionVisible } = await import('@/sync/domains/session/activeViewingSession');
        markSessionVisible('s1');
        if (owner === 'messagesSync') {
            storage.getState().applySessions([createSessionFixture({ id: 's1', seq: 2, encryptionMode: 'plain' })]);
            storage.getState().applyMessagesLoaded('s1');
        }
        const preexisting = owner === 'fetchSessions' ? runtime.fetchSessions() : undefined;
        if (owner === 'sessionsSync') runtime.sessionsSync.invalidate();
        if (owner === 'machinesSync') runtime.machinesSync.invalidate();
        if (owner === 'messagesSync') runtime.getOrCreateMessagesSync('s1').invalidate();
        await vi.waitFor(() => expect(reads).toBe(1));
        // This external write is omitted by the already-started read and precedes cursor capture.
        serverRevision = 2;
        const repair = runtime.resumeViaChanges({ accountId: 'test-account' }).finally(() => { settled = true; });
        try {
            await captured.promise;
            firstRead.resolve(undefined);
            await vi.waitFor(() => expect(settled || reads === 2).toBe(true));
            expect(runtime.changesCursor).toBe(trigger === 'missing-cursor' ? null : trigger === 'page-budget' ? '10' : '9');
            expect(reads).toBe(2);
            expect(readMaterializedRevision()).toBe(1);

            freshRead.resolve(undefined);
            await repair;
            expect(readMaterializedRevision()).toBe(2);
            expect(runtime.changesCursor).toBe('11');
            expect(revisionsAtChangesRead).toEqual(trigger === 'page-budget' ? [] : [2]);
        } finally {
            firstRead.resolve(undefined);
            freshRead.resolve(undefined);
            await preexisting;
            await repair;
        }
    });

    it.each(['expired', 'stopped'] as const)('does not checkpoint a missing cursor when the real snapshot queue is %s', async (reason) => {
        vi.useFakeTimers();
        runtime.syncTuning = { ...runtime.syncTuning, invalidateSyncAwaitTimeoutMs: 25 };
        const response = createDeferred<Response>();
        const requestedPaths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            requestedPaths.push(url.pathname);
            if (url.pathname === '/v2/cursor') {
                if (reason === 'stopped') runtime.sessionsSync.stop();
                return Response.json({ cursor: 42, changesFloor: 0 });
            }
            if (url.pathname === '/v2/session-organization') {
                return Response.json({ snapshot: {
                    schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
                    tags: [], tagAssignments: [], orderEntries: [], labels: [],
                } });
            }
            if (url.pathname === '/v2/sessions') {
                return response.promise;
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));

        let settled = false;
        const pending = runtime.resumeViaChanges({ accountId: 'test-account' }).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect({ settled, requestedPaths }).toMatchObject({ settled: true }));
            await pending;

            expect(runtime.changesCursor).toBeNull();
            expect(requestedPaths).not.toContain('/v2/changes');
            if (reason === 'expired') expect(requestedPaths).toContain('/v2/sessions');
        } finally {
            runtime.sessionsSync.stop();
            response.resolve(Response.json({ sessions: [], nextCursor: null, hasNext: false }));
            await runtime.sessionsSync.awaitQueue();
        }
    });
});
