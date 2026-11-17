import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeGovernanceProjectionV1Schema, NO_HOME_CAPABILITIES_V1 } from '@happier-dev/protocol/home/governance';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import type { IrohNativeLifecycleModule } from '@/sync/runtime/nativeIrohTunnels/supervisor';
import { createBrowserIrohSharedEndpointOwner } from '@/sync/runtime/browserIroh/sharedEndpointOwner';
import { createBrowserIrohWorkerConnectionHandler, type BrowserIrohMessagePort } from '@/sync/runtime/browserIroh/workerConnection';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';

const nativeStorage = new Map<string, string>();
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
installTokenStorageWebPlatformMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { get OS() { return platform.os; } },
    }),
    secureStore: async () => ({
        getItemAsync: async (key: string) => nativeStorage.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => { nativeStorage.set(key, value); },
        deleteItemAsync: async (key: string) => { nativeStorage.delete(key); },
    }),
});
installTokenStorageTestIsolation('home-action-carriers');
const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { adoptHomeProfile, setActiveServerId, upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } = await import('@/sync/runtime/nativeIrohTunnels/runtime');
const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { resetServerReachabilitySupervisors, setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { resolvePackagedBrowserIrohEndpointClient, resetPackagedBrowserIrohEndpointClientForTests } = await import('@/sync/runtime/browserIroh/endpointClient');
const { requestHomeDomain } = await import('./homeServerActionTransport');
let restoreBrowserStorage: (() => void) | undefined;
const runtimeFetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const ensureHomeTunnel = vi.fn<IrohNativeLifecycleModule['ensureHomeTunnel']>();
const releaseHomeTunnel = vi.fn<IrohNativeLifecycleModule['releaseHomeTunnel']>();
const runtimeOrigin = 'http://127.0.0.1:49152';
const endpointId = 'a'.repeat(64);
const canonicalUrl = 'https://server-a.example';
const token = createAccountTokenForTests('account-a');

async function prepareHome() {
    const active = await upsertServerProfile({ serverUrl: 'https://other.example', name: 'Other' });
    await setActiveServerId(active.id);
    await adoptHomeProfile({ source: 'qr', descriptor: {
        v: 1, homeServerIdentityId: 'srv_server_a', canonicalServerUrl: canonicalUrl, revision: 1,
        endpoints: [{ kind: 'iroh', endpointId, relayUrls: ['https://relay.example'] }],
    } });
    await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: 'srv_server_a' }, { token });
}

function projection() {
    return homeGovernanceProjectionFixture({
        viewer: { accountId: 'account-a', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        activeOwnerCount: 1,
    });
}

const scope = { serverId: 'srv_server_a', accountId: 'account-a' } as const;

function governanceRequest(signal?: AbortSignal) {
    return requestHomeDomain({
        scope,
        path: '/v1/home/governance/get',
        effect: 'read',
        input: {},
        schema: HomeGovernanceProjectionV1Schema,
        ...(signal ? { signal } : {}),
    });
}

beforeEach(async () => {
    platform.os = 'ios';
    nativeStorage.clear();
    runtimeFetchMock.mockReset();
    releaseHomeTunnel.mockReset();
    releaseHomeTunnel.mockResolvedValue(undefined);
    ensureHomeTunnel.mockReset();
    ensureHomeTunnel.mockResolvedValue({ leaseId: 'home-lease', homeServerIdentityId: 'srv_server_a',
        homeEndpointId: endpointId, runtimeOrigin, carrier: 'iroh', observedPath: 'direct', startedAtMs: 1 });
    getIrohHomeTunnelRuntime({ native: { ensureHomeTunnel, releaseHomeTunnel } });
    setServerReachabilityNetworkAllowed(true);
    setRuntimeFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/features')) return Response.json(createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_server_a' } } }));
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({});
        return runtimeFetchMock(url, init);
    });
    await prepareHome();
});
afterEach(async () => {
    if (typeof globalThis.SharedWorker === 'function') {
        const client = resolvePackagedBrowserIrohEndpointClient();
        await client.releaseAll();
        client.close();
        resetPackagedBrowserIrohEndpointClientForTests();
    }
    await disposeIrohHomeTunnelRuntime();
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    restoreBrowserStorage?.();
    restoreBrowserStorage = undefined;
    platform.os = 'ios';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Home family transport composition', () => {
    it('travels the native Iroh runtime origin the scoped transport resolved', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify(projection()), { status: 200 }));

        await expect(governanceRequest()).resolves.toEqual({ ok: true, value: projection() });

        const [url, init] = runtimeFetchMock.mock.calls[0]!;
        // Identity and audience stay the canonical Home URL; only the reachable
        // origin is the resolved Iroh one.
        expect(url).toBe(`${runtimeOrigin}/v1/home/governance/get`);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({ homeServerIdentityId: 'srv_server_a', endpointId }));
    });

    it('travels a browser Iroh Home through its real worker, carrier and HTTP owners', async () => {
        platform.os = 'web';
        vi.stubGlobal('location', { origin: 'https://ui.example.test' });
        restoreBrowserStorage = installLocalStorageMock().restore;
        await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: 'srv_server_a' }, { token });
        const written: string[] = [];
        const owner = createBrowserIrohSharedEndpointOwner({
            randomBytes: length => new Uint8Array(length).fill(1),
            bindEndpoint: async ({ relayUrls }) => ({
                endpointId: 'browser-endpoint', appliedRelayUrls: () => relayUrls, applyRelayUrls: async () => {},
                closeConnection: async () => {}, close: async () => {},
                openStream: async input => {
                    let request = '';
                    let answer: Uint8Array | undefined;
                    return {
                        remoteEndpointId: input.endpointId, observedPath: 'relay',
                        write: async bytes => { request += new TextDecoder().decode(bytes); },
                        finishWrite: async () => {}, cancel: () => {}, close: async () => {},
                        read: async maxBytes => {
                            if (answer === undefined) {
                                written.push(request);
                                const body = JSON.stringify(request.includes('/v1/home/governance/get') ? projection() :
                                    request.includes('/v1/features') ? { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_server_a' } } } : {});
                                answer = new TextEncoder().encode(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`);
                            }
                            const bytes = answer.subarray(0, maxBytes);
                            answer = answer.subarray(bytes.length);
                            return { bytes, done: bytes.length === 0 };
                        },
                    };
                },
            }),
        });
        const handler = createBrowserIrohWorkerConnectionHandler(owner);
        // SharedWorker is the browser process boundary. Its command handler,
        // endpoint ownership, stream codec and Home carrier stay real.
        vi.stubGlobal('SharedWorker', class {
            port: BrowserIrohMessagePort;
            onerror = null;
            constructor() {
                const pageListeners: Array<(event: { data: unknown }) => void> = [];
                const workerListeners: Array<(event: { data: unknown }) => void> = [];
                this.port = { postMessage: data => workerListeners.forEach(listener => listener({ data })),
                    addEventListener: (_type, listener) => { pageListeners.push(listener); } };
                handler({ postMessage: data => pageListeners.forEach(listener => listener({ data })),
                    addEventListener: (_type, listener) => { workerListeners.push(listener); } });
            }
        });

        await expect(governanceRequest()).resolves.toEqual({ ok: true, value: projection() });

        const operation = written.find(request => request.startsWith('POST /v1/home/governance/get '));
        expect(operation).toContain('host: server-a.example');
        expect(operation).toContain(`Bearer ${token}`);
        expect(operation?.split('\r\n\r\n')[1]).toBe('2\r\n{}\r\n0');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(ensureHomeTunnel).not.toHaveBeenCalled();
        expect(owner.status().leaseCount).toBe(0);
    });

    it('releases the scoped lease after the answer is read, on success and on refusal alike', async () => {
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projection()), { status: 200 }));
        await expect(governanceRequest()).resolves.toMatchObject({ ok: true });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);

        runtimeFetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'home_governance_forbidden' }), { status: 403 }),
        );
        await expect(governanceRequest()).resolves.toMatchObject({ ok: false });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(2);
    });

    it('lets a caller\'s cancellation surface as cancellation and still releases the lease', async () => {
        const controller = new AbortController();
        runtimeFetchMock.mockImplementation(async () => {
            controller.abort();
            const aborted = new Error('aborted');
            aborted.name = 'AbortError';
            throw aborted;
        });

        // Cancellation is the caller's own supersession, not a Home failure: it
        // must not be reported as an unreachable Home the caller would retry.
        await expect(governanceRequest(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });
});
