import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: getCredentialsForServerUrlMock,
        },
    };
});

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { searchHomeMemory } from './searchHomeMemory';
import { searchConversations, mergeConversationSearchHits } from '../search/searchConversations';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

beforeEach(() => {
    kvStore.clear();
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    createEncryptionFromAuthCredentialsMock.mockReset();
});

afterEach(() => {
    kvStore.clear();
});

function createHomeSearchHit(sessionId: string, summary = 'Personal Home summary', score = 0.9) {
    return {
        sessionId,
        seqFrom: 1,
        seqTo: 3,
        createdAtFromMs: 10,
        createdAtToMs: 20,
        summary,
        score,
    };
}

async function activateHome(name: string, serverUrl: string): Promise<string> {
    const profile = await upsertServerProfile({ serverUrl, name });
    await setActiveServerId(profile.id, { scope: 'device' });
    return profile.id;
}

function mockScopedHomeResponse(response: Response): void {
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account'), secret: 'secret' });
    createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
    runtimeFetchMock.mockResolvedValue(response);
}

describe('searchHomeMemory', () => {
    it('deduplicates Home and daemon Session hits at the fan-out owner without comparing their scores', async () => {
        const home = await activateHome('Home', 'https://dedupe-home.test');
        mockScopedHomeResponse(new Response(JSON.stringify({ v: 1, ok: true,
            hits: [createHomeSearchHit('same', 'Home match', 1)] }), { status: 200 }));
        machineRpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true,
                deepIndexReady: true, activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
                embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null,
                embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
                tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null }
                : { v: 1, ok: true, hits: [{ ...createHomeSearchHit('same', 'Daemon match', 0.1), createdAtToMs: 30 }] });
        const result = await searchConversations({ serverId: home, accountId: 'account', machines: [{ id: 'one', online: true }],
            concurrencyLimit: 2, homeSessions: true, mode: 'indexed',
            query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto' } });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]).toMatchObject({ machineId: null, hit: { sessionId: 'same', summary: 'Home match' } });
        const daemon = await searchConversations({ serverId: home, accountId: 'account', machines: [{ id: 'one', online: true }],
            concurrencyLimit: 2, homeSessions: false, mode: 'indexed',
            query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto', corpora: ['sessions'] } });
        const merged = mergeConversationSearchHits([...result.hits, ...daemon.hits]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ machineId: 'one', hit: { sessionId: 'same', summary: 'Daemon match' } });
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input.url).includes('/v1/home/search'))).toBe(true);
    });

    it('posts the shared MemorySearchQueryV1 to /v1/home/search for the focused Home target and parses the shared result', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        mockScopedHomeResponse(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [createHomeSearchHit('session-1')],
        }), { status: 200 }));

        const result = await searchHomeMemory({
            serverId: homeA,
            accountId: 'account',
            query: ' vector cache ',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 20,
        });

        expect(serverFetchMock).not.toHaveBeenCalled();
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input?.url).includes('/v1/home/search'));
        const init = call?.[0]?.init;
        expect(call?.[0]?.url).toBe('https://home-a.example/v1/home/search');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init?.body ?? '{}')).toEqual({
            v: 1,
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 20,
        });
        expect(result).toEqual({
            v: 1,
            ok: true,
            hits: [createHomeSearchHit('session-1')],
        });
    });

    it('sends contextual Session eligibility and rejects unfiltered legacy hits', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        mockScopedHomeResponse(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [
                createHomeSearchHit('active-session'),
                createHomeSearchHit('archived-session'),
            ],
        }), { status: 200 }));

        const result = await searchHomeMemory({
            serverId: homeA,
            accountId: 'account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            eligibleSessionIds: ['archived-session'],
            maxResults: 20,
        });

        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input?.url).includes('/v1/home/search'));
        const init = call?.[0]?.init;
        expect(JSON.parse(init?.body ?? '{}')).toEqual(expect.objectContaining({
            eligibleSessionIds: ['archived-session'],
        }));
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: 'archived-session' })],
        }));
    });

    it('sends an explicit Home B query to Home B while Home A stays focused', async () => {
        await activateHome('Home A', 'https://home-a.example');
        const homeB = await upsertServerProfile({ serverUrl: 'https://home-b.example', name: 'Home B' });
        const homeBToken = tokenForSub('home-b-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: homeBToken, secret: 'home-b-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [createHomeSearchHit('home-b-session')],
        }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }));

        const result = await searchHomeMemory({
            serverId: homeB.id,
            accountId: 'home-b-account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith(
            'https://home-b.example',
            expect.objectContaining({ serverId: homeB.id }),
        );
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input?.url).includes('/v1/home/search'));
        expect(call?.[0]?.url).toBe('https://home-b.example/v1/home/search');
        expect(new Headers(call?.[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${homeBToken}`);
        expect(JSON.parse(String(call?.[0]?.init?.body ?? '{}'))).toMatchObject({ query: 'vector cache' });
        expect(result).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 'home-b-session' })] });
    });

    it('rejects credentials for a different Account than the exact requested Home scope', async () => {
        const homeB = await activateHome('Home B', 'https://home-b.example');
        getCredentialsForServerUrlMock.mockResolvedValue({
            token: tokenForSub('different-account'),
            secret: 'home-b-secret',
        });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});

        const result = await searchHomeMemory({
            serverId: homeB,
            accountId: 'expected-account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'memory_failed' });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('uses explicitly scoped Home authority even when the target is the focused Home', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        const homeAToken = tokenForSub('home-a-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: homeAToken, secret: 'home-a-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [createHomeSearchHit('home-a-session')],
        }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }));

        const result = await searchHomeMemory({
            serverId: homeA,
            accountId: 'home-a-account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        // The ambient active-request transport resolves its Home at fetch time, so an
        // explicit target must never route through it — not even when it currently
        // matches focus.
        expect(serverFetchMock).not.toHaveBeenCalled();
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input?.url).includes('/v1/home/search'));
        expect(call?.[0]?.url).toBe('https://home-a.example/v1/home/search');
        expect(new Headers(call?.[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${homeAToken}`);
        expect(result).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 'home-a-session' })] });
    });

    it('keeps the request bound to the explicitly targeted Home when focus moves during resolution', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        const homeB = await upsertServerProfile({ serverUrl: 'https://home-b.example', name: 'Home B' });
        const homeAToken = tokenForSub('home-a-account');
        const homeBToken = tokenForSub('home-b-account');
        // Focus flips to Home B while the target's credentials are still resolving.
        getCredentialsForServerUrlMock.mockImplementation(async (serverUrl: string) => {
            await setActiveServerId(homeB.id, { scope: 'device' });
            return serverUrl === 'https://home-a.example'
                ? { token: homeAToken, secret: 'home-a-secret' }
                : { token: homeBToken, secret: 'home-b-secret' };
        });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [createHomeSearchHit('home-a-session')],
        }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }));

        const result = await searchHomeMemory({
            serverId: homeA,
            accountId: 'home-a-account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(serverFetchMock).not.toHaveBeenCalled();
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input?.url).includes('/v1/home/search'));
        expect(call?.[0]?.url).toBe('https://home-a.example/v1/home/search');
        expect(new Headers(call?.[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${homeAToken}`);
        expect(result).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 'home-a-session' })] });
    });

    it('refuses to search without an explicit Home target instead of using the focused Home', async () => {
        await activateHome('Home A', 'https://home-a.example');

        const result = await searchHomeMemory({
            serverId: '  ',
            accountId: 'account',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(result).toMatchObject({ v: 1, ok: false, errorCode: 'memory_invalid_query' });
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed Home result as a typed failure instead of a false success', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        mockScopedHomeResponse(new Response(JSON.stringify({
            v: 1,
            ok: true,
            hits: [{ sessionId: '', seqFrom: -1 }],
        }), { status: 200 }));

        const malformedHits = await searchHomeMemory({
            serverId: homeA,
            accountId: 'account',
            query: 'vector',
            scope: { type: 'global' },
            mode: 'auto',
        });
        expect(malformedHits).toMatchObject({ v: 1, ok: false, errorCode: 'memory_failed' });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps Home endpoint unavailability to a typed unavailable result', async () => {
        const homeA = await activateHome('Home A', 'https://home-a.example');
        mockScopedHomeResponse(new Response(null, { status: 404 }));

        const unavailable = await searchHomeMemory({
            serverId: homeA,
            accountId: 'account',
            query: 'vector',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(unavailable).toMatchObject({ v: 1, ok: false, errorCode: 'memory_index_missing' });
    });
});
