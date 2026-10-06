import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    captureServerRequestAuthorityForServerAccountScope,
    createServerRequestForResolvedServerScope,
    createServerRequestWithServerScope,
    resolveServerRequestForServerAccountScope,
} from './createServerRequestWithServerScope';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);

const credentials = new Map<string, { token: string }>();
const requests: Array<{ url: string; init: RequestInit }> = [];
let activeHome: Awaited<ReturnType<typeof upsertAndActivateServer>>;

beforeEach(async () => {
    credentials.clear();
    requests.length = 0;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => credentials.get(url) ?? null);
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/auth/ping') return Response.json({});
        // The cold Socket.IO boundary publishes no background domain rows.
        if (['/v1/profile', '/v2/account/settings', '/v2/sessions', '/v1/machines'].includes(url.pathname)) {
            return Response.json({}, { status: 404 });
        }
        requests.push({ url: url.href, init: init ?? {} });
        return new Response(null, { status: 200 });
    });
    activeHome = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    const activeCredentials = { token: createAccountTokenForTests('active-account') };
    credentials.set(activeHome.serverUrl, activeCredentials);
    await restoreConnectionToActiveServer(activeCredentials);
    requests.length = 0;
});

afterEach(async () => {
    await disconnectActiveServerConnection();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

async function addHome(url: string, accountId: string) {
    const home = await upsertServerProfile({ serverUrl: url, name: accountId });
    const token = createAccountTokenForTests(accountId);
    credentials.set(home.serverUrl, { token });
    return { ...home, token };
}
const noActiveFallback = async () => { throw new Error('must not substitute focused Home authority'); };

describe('createServerRequestWithServerScope', () => {
    it('captures the actual Account on an explicit Home when the caller has only a Session address', async () => {
        const first = await addHome('https://first.example', 'account-first');
        const second = await addHome('https://second.example', 'account-second');
        await setActiveServerId(second.id, { scope: 'device' });
        const authority = await captureServerRequestAuthorityForServerAccountScope({ serverId: first.id, activeRequest: noActiveFallback });
        expect(authority.scope).toEqual({ serverId: first.id, accountId: 'account-first' });
        await setActiveServerId(first.id, { scope: 'device' });
        try { expect((await authority.request('/v2/sessions/session/system-records')).status).toBe(200); }
        finally { await authority.release(); }
        const request = requests.find(({ url }) => url.endsWith('/system-records'));
        expect(request?.url).toBe('https://first.example/v2/sessions/session/system-records');
        expect(new Headers(request?.init.headers).get('authorization')).toBe(`Bearer ${first.token}`);
    });

    it('does not turn an empty explicit Home into focused-Home authority', async () => {
        await expect(captureServerRequestAuthorityForServerAccountScope({ serverId: ' ', activeRequest: noActiveFallback })).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });

    it('uses the active request when the target Home has an applied Account lifetime', async () => {
        const issued: Array<{ path: string; method?: string }> = [];
        const request = createServerRequestWithServerScope({ serverId: activeHome.id,
            activeRequest: async (path, init) => { issued.push({ path, method: init?.method }); return new Response(null, { status: 201 }); },
        });
        expect((await request('/v1/sessions/s1/messages', { method: 'GET' })).status).toBe(201);
        expect(issued).toEqual([{ path: '/v1/sessions/s1/messages', method: 'GET' }]);
        expect(requests).toHaveLength(0);
    });

    it('uses runtimeFetch with scoped auth when the target Home is not active', async () => {
        const owner = await addHome('https://owner.example', 'owner-account');
        const request = createServerRequestWithServerScope({ serverId: owner.id, activeRequest: noActiveFallback });
        expect((await request('/v1/sessions/s1/messages?scope=main', { method: 'GET' })).status).toBe(200);
        const sent = requests.find(({ url }) => url.endsWith('/v1/sessions/s1/messages?scope=main'));
        expect(sent?.url).toBe('https://owner.example/v1/sessions/s1/messages?scope=main');
        expect(sent?.init.method).toBe('GET');
        expect(new Headers(sent?.init.headers).get('authorization')).toBe(`Bearer ${owner.token}`);
    });

    it('preserves request body and existing headers for non-GET scoped requests', async () => {
        const owner = await addHome('https://owner.example', 'owner-account');
        const request = createServerRequestWithServerScope({ serverId: owner.id, activeRequest: noActiveFallback });
        const body = JSON.stringify({ hello: 'world' });
        expect((await request('/v2/sessions/s1/pending', { method: 'POST', body,
            headers: { 'Content-Type': 'application/json', 'X-Test': '1' } })).status).toBe(200);
        const sent = requests.find(({ url }) => url.endsWith('/v2/sessions/s1/pending'));
        expect(sent?.init).toMatchObject({ method: 'POST', body });
        const headers = new Headers(sent?.init.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${owner.token}`);
        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get('x-test')).toBe('1');
    });

    it('binds an outbox action request to the exact persisted Home and authenticated Account', async () => {
        const owner = await addHome('https://owner.example', 'account-owner');
        const authority = await resolveServerRequestForServerAccountScope({ scope: { serverId: owner.id, accountId: 'account-owner' }, activeRequest: noActiveFallback });
        try { expect((await authority.request('/v2/sessions/s1/pending', { method: 'POST', body: 'exact-body' })).status).toBe(200); }
        finally { await authority.release(); }
        const sent = requests.find(({ url }) => url.endsWith('/v2/sessions/s1/pending'));
        expect(sent?.url).toBe('https://owner.example/v2/sessions/s1/pending');
        expect(sent?.init.body).toBe('exact-body');
        expect(new Headers(sent?.init.headers).get('authorization')).toBe(`Bearer ${owner.token}`);
    });

    it('keeps a same-Home request bound to the captured Account after stored credentials change', async () => {
        const accountAToken = createAccountTokenForTests('account-a');
        credentials.set(activeHome.serverUrl, { token: accountAToken });
        const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: { serverId: activeHome.id, accountId: 'account-a' }, activeRequest: noActiveFallback });
        credentials.set(activeHome.serverUrl, { token: createAccountTokenForTests('account-b') });
        try { expect((await authority.request('/v1/sessions/history/messages', { method: 'GET' })).status).toBe(200); }
        finally { await authority.release(); }
        const sent = requests.find(({ url }) => url.endsWith('/v1/sessions/history/messages'));
        expect(new Headers(sent?.init.headers).get('authorization')).toBe(`Bearer ${accountAToken}`);
        expect(authority.scope).toEqual({ serverId: activeHome.id, accountId: 'account-a' });
    });

    it('rejects credentials whose authenticated Account does not match the persisted outbox scope', async () => {
        const owner = await addHome('https://owner.example', 'different-account');
        await expect(resolveServerRequestForServerAccountScope({ scope: { serverId: owner.id, accountId: 'account-owner' }, activeRequest: noActiveFallback })).rejects.toThrow('authenticated account does not match');
        expect(requests).toHaveLength(0);
    });

    it('carries a request over the resolved semantic Home carrier instead of its unreachable URL', async () => {
        const token = createAccountTokenForTests('account-a');
        const carried: Array<{ url: string; init: RequestInit }> = [];
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async (url: string, init: RequestInit) => { carried.push({ url, init }); return Response.json({ ok: true }); },
            createWebSocket: () => { throw new Error('this HTTP request must not open a socket'); },
        };
        const request = createServerRequestForResolvedServerScope({ context: {
            scope: 'scoped', timeoutMs: 5_000, targetServerId: 'srv_ingressless',
            targetServerUrl: 'https://ingressless.happier.invalid', targetAccountId: 'account-a',
            token, credentials: { token }, encryption: null, runtimeOrigin: 'https://ingressless.happier.invalid',
            carrier: 'iroh', homeCarrier,
        }, activeRequest: noActiveFallback });
        expect((await request('/v1/machines/peer/mediation/route-grants', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 2 }) })).status).toBe(200);
        expect(requests).toHaveLength(0);
        expect(carried).toHaveLength(1);
        expect(carried[0]?.url).toBe('https://ingressless.happier.invalid/v1/machines/peer/mediation/route-grants');
        expect(carried[0]?.init.method).toBe('POST');
        expect(new Headers(carried[0]?.init.headers).get('authorization')).toBe(`Bearer ${token}`);
    });
});
