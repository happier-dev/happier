import { afterEach, describe, expect, it, vi } from 'vitest';

import type { V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { sessionRuntimeObservations } from './sessionRuntimeObservation';

const boundary = vi.hoisted(() => ({
    captureAuthority: vi.fn(),
    credentialListeners: new Set<(event: Readonly<{ serverId: string; serverUrl: string; kind: 'credentials_set' | 'credentials_removed' }>) => void>(),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        subscribeHomeCredentialMutations: (listener: (event: Readonly<{ serverId: string; serverUrl: string; kind: 'credentials_set' | 'credentials_removed' }>) => void) => {
            boundary.credentialListeners.add(listener);
            return () => boundary.credentialListeners.delete(listener);
        },
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope')
    >();
    return {
        ...actual,
        captureServerRequestAuthorityForServerAccountScope: boundary.captureAuthority,
    };
});

import { ensureSessionMetadataInventoryForServerAccountScope } from './fetchSessionMetadataInventoryForServerAccountScope';

function row(id: string, archivedAt: number | null = null): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: archivedAt === null,
        activeAt: 1,
        archivedAt,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ name: id, path: `/work/${id}` }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        share: null,
    };
}

function response(sessions: readonly V2SessionRecord[], nextCursor: string | null): Response {
    return new Response(JSON.stringify({
        sessions,
        nextCursor,
        hasNext: nextCursor !== null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createInventoryRequestBoundary(request: (path: string, init: RequestInit) => Promise<Response>) {
    // The route spy observes list progression; full source facts are served only
    // beneath the canonical compact-list/read-batch HTTP fixture boundary.
    return createCompactSessionListFetchBoundary(async (path, init) => {
        if (new URL(path, 'https://home-b.example.test').pathname === '/v2/sessions/read-batch') return undefined;
        return request(path, init);
    });
}

function createLifetime() {
    let current = true;
    const listeners = new Set<() => void>();
    return {
        lifetime: {
            isCurrent: () => current,
            onRetire: (listener: () => void) => {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
            },
        },
        retire: () => {
            current = false;
            for (const listener of listeners) listener();
        },
    };
}

afterEach(() => {
    boundary.captureAuthority.mockReset();
    for (const listener of [...boundary.credentialListeners]) {
        listener({ kind: 'credentials_removed', serverId: 'home-b', serverUrl: 'https://home-b.example.test' });
    }
    boundary.credentialListeners.clear();
    sessionRuntimeObservations.clear();
    storage.setState(storage.getInitialState(), true);
});

describe('ensureSessionMetadataInventoryForServerAccountScope', () => {
    it('publishes admitted pages while later pages remain pending without claiming complete membership', async () => {
        const secondPage = createDeferred<void>();
        const archivedPage = createDeferred<void>();
        let retired = false;
        let refreshedInventory = false;
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://home-b.example.test');
            if (url.pathname === '/v2/sessions/active') return response([], null);
            if (url.pathname === '/v2/sessions/archived') {
                await archivedPage.promise;
                return response([row('archived-page', 2), {
                    ...row('first-page', 2), metadataVersion: 2, updatedAt: 2,
                    metadata: JSON.stringify({ name: 'First page refreshed', path: '/work/first-page' }),
                }], null);
            }
            if (url.searchParams.has('cursor')) {
                await secondPage.promise;
                return response([row('second-page')], null);
            }
            return response(refreshedInventory ? [] : [row('first-page'), ...(retired ? [] : [row('retired-before-completion')])], 'second-page');
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } }, request: createInventoryRequestBoundary(request), release: vi.fn(async () => {}),
        });
        storage.getState().applyServerScopedSessionListRows('home-b', [createSessionListRenderableSessionFixture({
            id: 'removed-after-completion', metadata: { path: '/previous', name: 'Previous member' },
        })], { source: 'ordinary', mode: 'replace' });
        const initialMembership = storage.getState().ordinarySessionListMembershipByServerId['home-b'];
        const initialIndex = storage.getState().sessionListIndexByServerId['home-b'];
        const account = createLifetime();
        let complete = false;
        const work = ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' }, accountLifetime: account.lifetime, refresh: true,
        }).then(() => { complete = true; });
        try {
            await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
            expect(storage.getState().sessionListRowsByServerId['home-b']?.['first-page']?.metadata?.name).toBe('first-page');
            expect(complete).toBe(false);
            expect(storage.getState().ordinarySessionListMembershipByServerId['home-b']).toBe(initialMembership);
            expect(storage.getState().sessionListIndexByServerId['home-b']).toBe(initialIndex);
            expect(storage.getState().sessions).toEqual({});
            retired = true;
            storage.getState().deleteSession('retired-before-completion', 'home-b');
            secondPage.resolve(undefined);
            await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
            expect(storage.getState().sessionListRowsByServerId['home-b']?.['second-page']).toBeDefined();
            expect(complete).toBe(false);
            archivedPage.resolve(undefined);
            await work;
            refreshedInventory = true;
            const rows = storage.getState().sessionListRowsByServerId['home-b'];
            expect(Object.keys(rows ?? {}).sort()).toEqual(['archived-page', 'first-page', 'second-page']);
            expect([...(storage.getState().ordinarySessionListMembershipByServerId['home-b'] ?? [])].sort())
                .toEqual(['archived-page', 'first-page', 'second-page']);
            expect(rows?.['first-page']?.metadata?.name).toBe('First page refreshed');
            expect(storage.getState().sessions).toEqual({});

            let notifications = 0;
            const stop = storage.subscribe((next, previous) => {
                if (next.sessionListRowsByServerId !== previous.sessionListRowsByServerId) notifications += 1;
            });
            try {
                for (let refresh = 0; refresh < 3; refresh++) await ensureSessionMetadataInventoryForServerAccountScope({
                    scope: { serverId: 'home-b', accountId: 'account-b' }, accountLifetime: account.lifetime, refresh: true,
                });
                expect(storage.getState().sessionListRowsByServerId['home-b']).toBe(rows);
                expect(notifications).toBe(0);
            } finally { stop(); }
            expect(request.mock.calls.every(([path]) => ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived']
                .includes(new URL(path, 'https://home-b.example.test').pathname))).toBe(true);
            expect(request).toHaveBeenCalledTimes(16);
        } finally {
            secondPage.resolve(undefined);
            archivedPage.resolve(undefined);
            await work;
        }
    });

    it('publishes same-id inactive-Home metadata only to that server partition', async () => {
        const activeSession = {
            id: 'session-1',
            serverId: 'home-a',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            archivedAt: null,
            encryptionMode: 'plain',
            metadata: { name: 'Home A title', path: '/work/a', host: 'host-a' },
            metadataVersion: 1,
            agentState: {},
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies Session;
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [activeSession.id]: activeSession },
        }));
        const homeBRow = {
            ...row('session-1'),
            metadata: JSON.stringify({ name: 'Home B title', path: '/work/b' }),
            updatedAt: 20,
        };
        const request = vi.fn(async (path: string) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            if (pathname === '/v2/sessions/active') return response([], null);
            if (pathname === '/v2/sessions') return response([homeBRow], null);
            return response([], null);
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } },
            request: createInventoryRequestBoundary(request),
            release: vi.fn(async () => {}),
        });
        const account = createLifetime();

        await ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: account.lifetime,
            refresh: true,
        });

        expect(storage.getState().sessions['session-1']).toBe(activeSession);
        expect(storage.getState().sessionListRowsByServerId['home-b']?.['session-1']).toMatchObject({
            metadata: { name: 'Home B title', path: '/work/b' },
        });
    });

    it('keeps compact heartbeat clocks separate from full-publication witnesses across metadata pages', async () => {
        const archivedPage = createDeferred<void>();
        let refreshing = false;
        const request = vi.fn(async (path: string) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            if (pathname === '/v2/sessions/active') return response([], null);
            if (pathname === '/v2/sessions') return response([{
                ...row('heartbeat-row'), meaningfulActivityAt: 1,
                ...(refreshing ? { activeAt: 2, updatedAt: 2 } : {}),
            }], null);
            if (!refreshing) return response([], null);
            await archivedPage.promise;
            return response([{
                ...row('heartbeat-row', 3), activeAt: 2, updatedAt: 3, meaningfulActivityAt: 1, metadataVersion: 2,
                metadata: JSON.stringify({ name: 'Later metadata', path: '/work/heartbeat-row' }),
            }], null);
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } }, request: createInventoryRequestBoundary(request), release: vi.fn(async () => {}),
        });
        const account = createLifetime();
        const ensure = () => ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' }, accountLifetime: account.lifetime, refresh: true,
        });
        await ensure();
        const first = storage.getState().sessionListRowsByServerId['home-b']?.['heartbeat-row'];
        refreshing = true;
        const work = ensure();
        try {
            await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6));
            expect(storage.getState().sessionListRowsByServerId['home-b']?.['heartbeat-row']).toBe(first);
            const observation = sessionRuntimeObservations.read({ serverId: 'home-b', sessionId: 'heartbeat-row' });
            expect(observation?.activeAt).toBe(2);
            // Compact-list clocks do not prove that a full Session document was published.
            expect(observation?.fullPublicationUpdatedAt).toBeUndefined();
            archivedPage.resolve(undefined);
            await work;
            expect(storage.getState().sessionListRowsByServerId['home-b']?.['heartbeat-row']?.metadata?.name).toBe('Later metadata');
        } finally {
            archivedPage.resolve(undefined);
            await work;
        }
    });

    it('exhausts current and archived list cursors through one exact Account authority and applies scoped metadata rows', async () => {
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://home-b.example.test');
            const cursor = url.searchParams.get('cursor');
            if (url.pathname === '/v2/sessions/active') return response([], null);
            if (url.pathname === '/v2/sessions/archived') {
                return cursor
                    ? response([row('archived-page-2', 2)], null)
                    : response([row('archived-page-1', 1)], 'archived-next');
            }
            return cursor
                ? response([row('current-page-2')], null)
                : response([row('current-page-1')], 'current-next');
        });
        const release = vi.fn(async () => {});
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } },
            request: createInventoryRequestBoundary(request),
            release,
        });
        const account = createLifetime();

        await ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: account.lifetime,
            refresh: true,
        });

        expect(boundary.captureAuthority).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'home-b', accountId: 'account-b' },
        }));
        expect(request.mock.calls.map(([path]) => {
            const url = new URL(path, 'https://home-b.example.test');
            return [url.pathname, url.searchParams.get('cursor')];
        })).toEqual([
            ['/v2/sessions/active', null],
            ['/v2/sessions', null],
            ['/v2/sessions', 'current-next'],
            ['/v2/sessions/archived', null],
            ['/v2/sessions/archived', 'archived-next'],
        ]);
        expect(Object.keys(storage.getState().sessionListRowsByServerId['home-b'] ?? {}).sort()).toEqual([
            'archived-page-1',
            'archived-page-2',
            'current-page-1',
            'current-page-2',
        ]);
        expect(storage.getState().sessions).toEqual({});
        expect(storage.getState().sessionListRowsByServerId['home-b']?.['archived-page-2']).toMatchObject({
            metadata: { name: 'archived-page-2', path: '/work/archived-page-2' },
        });
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    });

    it('aborts and fences late publication when the exact Home credential retires', async () => {
        const request = vi.fn(async (path: string, init: RequestInit) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            if (pathname === '/v2/sessions/active') return response([], null);
            if (pathname === '/v2/sessions') return response([row('must-not-publish')], null);
            return await new Promise<Response>((_resolve, reject) => {
            expect(init.signal).toBeInstanceOf(AbortSignal);
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        });
        const release = vi.fn(async () => {});
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } },
            request: createInventoryRequestBoundary(request),
            release,
        });
        const account = createLifetime();
        const work = ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: account.lifetime,
            refresh: true,
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));

        for (const listener of boundary.credentialListeners) {
            listener({ kind: 'credentials_removed', serverId: 'home-b', serverUrl: 'https://home-b.example.test' });
        }
        await expect(work).rejects.toMatchObject({ name: 'AbortError' });

        expect(storage.getState().sessions['must-not-publish']).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId['home-b']).toBeUndefined();
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    });

    it('settles metadata inventory when a newer full-publication witness overtakes the list response', async () => {
        const sessionId = 'metadata-current-full-publication-newer';
        let metadataVersion = 2;
        const address = { serverId: 'home-b', sessionId };
        storage.getState().applyServerScopedSessionListRows('home-b', [createSessionListRenderableSessionFixture({
            id: sessionId, serverId: 'home-b', seq: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
            metadata: { name: 'Previous metadata', path: '/work/previous' },
        })], { source: 'ordinary', mode: 'replace' });
        sessionRuntimeObservations.observe(address, { active: true, activeAt: 1 });
        sessionRuntimeObservations.recordFullPublication(address, 3);
        const request = vi.fn(async (path: string) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            return response(pathname === '/v2/sessions' ? [{ ...row(sessionId), metadataVersion,
                metadata: JSON.stringify({ name: metadataVersion === 2 ? sessionId : 'Changed metadata', path: `/work/${sessionId}` }),
            }, row('unchanged-sibling')] : [], null);
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } }, request: createInventoryRequestBoundary(request), release: vi.fn(async () => {}),
        });
        const account = createLifetime();
        await ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: account.lifetime, refresh: true,
        });
        const first = storage.getState().sessionListRowsByServerId['home-b']?.[sessionId];
        const firstRows = storage.getState().sessionListRowsByServerId['home-b'];
        const sibling = firstRows?.['unchanged-sibling'];
        const membership = storage.getState().ordinarySessionListMembershipByServerId['home-b'];
        expect(first?.metadata).toMatchObject({ name: sessionId, path: `/work/${sessionId}` });
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        let publications = 0;
        const stop = storage.subscribe((next, previous) => {
            if (next.sessionListRowsByServerId !== previous.sessionListRowsByServerId) publications += 1;
        });
        try {
            for (let refresh = 0; refresh < 3; refresh++) await ensureSessionMetadataInventoryForServerAccountScope({
                scope: { serverId: 'home-b', accountId: 'account-b' }, accountLifetime: account.lifetime, refresh: true,
            });
            expect(storage.getState().sessionListRowsByServerId['home-b']).toBe(firstRows);
            expect(storage.getState().sessionListRowsByServerId['home-b']?.[sessionId]).toBe(first);
            expect(storage.getState().ordinarySessionListMembershipByServerId['home-b']).toBe(membership);
            expect(publications).toBe(0);
            metadataVersion = 3;
            await ensureSessionMetadataInventoryForServerAccountScope({
                scope: { serverId: 'home-b', accountId: 'account-b' }, accountLifetime: account.lifetime, refresh: true,
            });
            expect(storage.getState().sessionListRowsByServerId['home-b']?.[sessionId]?.metadata?.name).toBe('Changed metadata');
            expect(storage.getState().sessionListRowsByServerId['home-b']?.['unchanged-sibling']).toBe(sibling);
            expect(storage.getState().ordinarySessionListMembershipByServerId['home-b']).toBe(membership);
            expect(publications).toBe(1);
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
        } finally { stop(); }
        expect(request.mock.calls.every(([path]) => ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived']
            .includes(new URL(path, 'https://home-b.example.test').pathname))).toBe(true);
    });

    it('does not overwrite a newer scoped Sync create or update that lands while inventory is paging', async () => {
        const ordinaryPage = createDeferred<Response>();
        const archivedPage = createDeferred<Response>();
        const request = vi.fn(async (path: string) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            if (pathname === '/v2/sessions/active') return response([], null);
            if (pathname === '/v2/sessions') {
                return await ordinaryPage.promise;
            }
            return await archivedPage.promise;
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } },
            request: createInventoryRequestBoundary(request),
            release: vi.fn(async () => {}),
        });
        const account = createLifetime();
        storage.getState().mergeSessionListRowsForServerScope('home-b', [
            createSessionListRenderableSessionFixture({
                id: 'updated-during-inventory',
                updatedAt: 5,
                archivedAt: null,
                metadata: { name: 'Before inventory', path: '/work/before', host: 'home-b-host' },
            }),
            createSessionListRenderableSessionFixture({
                id: 'unchanged-before-inventory',
                updatedAt: 5,
                archivedAt: null,
                metadata: { name: 'Removed remotely', path: '/work/removed', host: 'home-b-host' },
            }),
            createSessionListRenderableSessionFixture({
                id: 'full-publication-during-inventory',
                metadata: { name: 'Full publication', path: '/work/full' },
            }),
        ]);
        const fullAddress = { serverId: 'home-b', sessionId: 'full-publication-during-inventory' };
        sessionRuntimeObservations.observe(fullAddress, { active: false, activeAt: 1 });
        sessionRuntimeObservations.recordFullPublication(fullAddress, 1);
        const fullRow = storage.getState().sessionListRowsByServerId['home-b']?.[fullAddress.sessionId];

        const work = ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: account.lifetime,
            refresh: true,
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

        storage.getState().mergeSessionListRowsForServerScope('home-b', [
            createSessionListRenderableSessionFixture({
                id: 'updated-during-inventory',
                updatedAt: 20,
                archivedAt: null,
                metadata: { name: 'Newer Sync title', path: '/work/newer', host: 'home-b-host' },
            }),
            createSessionListRenderableSessionFixture({
                id: 'created-during-inventory',
                updatedAt: 20,
                archivedAt: null,
                metadata: { name: 'New Sync session', path: '/work/new', host: 'home-b-host' },
            }),
        ]);
        sessionRuntimeObservations.recordFullPublication(fullAddress, 2);
        ordinaryPage.resolve(response([
            { ...row('updated-during-inventory'), metadataVersion: 50, updatedAt: 50 },
            { ...row(fullAddress.sessionId), metadataVersion: 50, updatedAt: 50 },
        ], null));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
        expect(storage.getState().sessionListRowsByServerId['home-b']?.['updated-during-inventory']?.metadata?.name)
            .toBe('Newer Sync title');
        expect(storage.getState().sessionListRowsByServerId['home-b']?.[fullAddress.sessionId]).toBe(fullRow);
        archivedPage.resolve(response([], null));
        await work;

        const rows = storage.getState().sessionListRowsByServerId['home-b'];
        expect(rows?.['updated-during-inventory']).toMatchObject({
            updatedAt: 20,
            metadata: { name: 'Newer Sync title' },
        });
        expect(rows?.['created-during-inventory']).toMatchObject({
            metadata: { name: 'New Sync session' },
        });
        expect(rows?.['unchanged-before-inventory']).toBeUndefined();
        expect(rows?.[fullAddress.sessionId]).toBe(fullRow);
        expect(storage.getState().ordinarySessionListMembershipByServerId['home-b']).toEqual([
            'updated-during-inventory',
            'full-publication-during-inventory',
            'created-during-inventory',
        ]);
    });

    it('shares one scoped inventory across consumers while detaching a retired caller independently', async () => {
        const archivedPage = createDeferred<Response>();
        const request = vi.fn(async (path: string, init: RequestInit) => {
            const pathname = new URL(path, 'https://home-b.example.test').pathname;
            if (pathname === '/v2/sessions/active') return response([], null);
            if (pathname === '/v2/sessions') return response([row('shared-row')], null);
            return await archivedPage.promise;
        });
        boundary.captureAuthority.mockResolvedValue({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            context: { credentials: { token: 'token-b' } },
            request: createInventoryRequestBoundary(request),
            release: vi.fn(async () => {}),
        });
        const first = createLifetime();
        const second = createLifetime();
        const firstWork = ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: first.lifetime,
            refresh: true,
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
        const secondWork = ensureSessionMetadataInventoryForServerAccountScope({
            scope: { serverId: 'home-b', accountId: 'account-b' },
            accountLifetime: second.lifetime,
        });

        first.retire();
        await expect(firstWork).rejects.toMatchObject({ name: 'AbortError' });
        expect(request.mock.calls.at(-1)?.[1].signal?.aborted).toBe(false);
        archivedPage.resolve(response([], null));
        await secondWork;

        expect(boundary.captureAuthority).toHaveBeenCalledOnce();
        expect(storage.getState().sessionListRowsByServerId['home-b']?.['shared-row']).toBeDefined();
    });
});
