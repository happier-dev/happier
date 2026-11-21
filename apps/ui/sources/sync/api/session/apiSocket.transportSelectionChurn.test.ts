import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('transport-selection-churn');
const { apiSocket } = await import('./apiSocket');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

beforeEach(() => h.reset());
afterEach(async () => {
    apiSocket.disconnect();
    vi.useRealTimers();
    await h.cleanup();
});
afterAll(() => h.dispose());

describe('ApiSocket and scoped HTTP transport selection', () => {
    it('reconnects the published focused Home and resumes its Account reconciliation after transport loss', async () => {
        const home = await h.profiles.adoptHomeProfile({ source: 'manual', descriptor: {
            v: 1, homeServerIdentityId: 'srv_transport_reconnect', canonicalServerUrl: h.homeA.serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: h.homeA.serverUrl }],
        } });
        await h.profiles.setActiveServerId(home.id, { scope: 'device' });
        await h.select([h.homeA.id]);
        await h.startFocused();
        const snapshot = h.profiles.getActiveServerSnapshot();
        expect(snapshot.carrier).toBe('https');
        const connectedWakes: string[] = [];
        const releaseWakes = subscribeHomeAccountChange(event => {
            if (event.serverId === snapshot.serverId && event.source === 'connected') connectedWakes.push(event.serverId);
        }, { reconnect: 'refresh' });
        const statuses: string[] = [];
        const releaseStatus = apiSocket.onStatusChange(status => statuses.push(status));
        try {
            await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
            connectedWakes.length = 0;
            h.socket(h.homeA).trigger('disconnect', 'transport close');
            expect(statuses.at(-1)).toBe('disconnected');
            await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
            await vi.waitFor(() => expect(connectedWakes).toEqual([snapshot.serverId]));
        } finally {
            releaseStatus();
            releaseWakes();
        }
    });

    it('keeps the reconnected Account observation available to captured identity readers', async () => {
        const { captureAccountEncryptionObservationForHome, bindAccountEncryptionObservation } =
            await import('@/sync/http/accountEncryptionObservationBinding');
        const { fetchAccountEncryptionIdentity } = await import('../account/apiAccountEncryptionMode');
        const { createPlainAccountEncryptionCurrentnessFixture } =
            await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const credentials = { token: h.homeA.token };
        let currentness = createPlainAccountEncryptionCurrentnessFixture();
        h.setResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(currentness) : null);
        await h.startFocused(credentials);
        const previous = h.socket(h.homeA);
        const scope = { serverId: h.homeA.id, endpointUrl: h.homeA.serverUrl, credentials };
        await vi.waitFor(() => expect(captureAccountEncryptionObservationForHome(scope)).toBeDefined());
        const binding = captureAccountEncryptionObservationForHome(scope)!;
        const request = bindAccountEncryptionObservation(createServerFetchAtEndpoint(scope), binding);
        const readIdentity = () => fetchAccountEncryptionIdentity(credentials, { request, usage: 'identity' });
        await expect(readIdentity()).resolves.toMatchObject({ mode: 'plain', updatedAt: 1 });

        previous.trigger('disconnect', 'transport close');
        expect(binding.peek()).toBeNull();
        currentness = createPlainAccountEncryptionCurrentnessFixture({ version: 2, updatedAt: 2 });
        await vi.waitFor(() => {
            expect(h.socket(h.homeA)).not.toBe(previous);
            expect(h.socket(h.homeA).socket.connected).toBe(true);
        });
        await expect(readIdentity()).resolves.toMatchObject({ mode: 'plain', updatedAt: 2 });

        // The transport error channel can report an error on an admitted socket
        // without a disconnect. No further connect event will follow it.
        const reconnected = h.socket(h.homeA);
        const reads = h.requests('/v1/account/encryption/currentness').length;
        reconnected.trigger('error', {
            type: 'peer-tunnel',
            error: 'Server-routed peer tunnel frame arrived before an authorized open',
        });
        expect(reconnected.socket.connected).toBe(true);
        await expect(readIdentity()).resolves.toMatchObject({ mode: 'plain', updatedAt: 2 });
        expect(h.requests('/v1/account/encryption/currentness')).toHaveLength(reads);
    });

    it('retains one admitted primary socket when healthy reads select two origins for the same Home and bearer', async () => {
        await h.select([h.homeA.id]);
        await h.startFocused();
        // C is only a byte-transport alias here: the canonical Home, Account and
        // bearer remain A for both request owners. No second Home socket is started.
        const runtimeOrigin = h.homeC.serverUrl;
        h.setResponder(async input => {
            const url = new URL(String(input));
            return url.pathname === '/v1/deployments/projects/source-a'
                ? Response.json({}) : null;
        });
        const firstSocketIndex = h.network.socketBoundaries.length;
        const snapshot = h.profiles.getActiveServerSnapshot();
        apiSocket.initialize({ endpoint: h.homeA.serverUrl, runtimeOrigin,
            token: h.homeA.token, serverId: h.homeA.id, generation: snapshot.generation,
            homeCarrier: null }, null);
        const sockets = () => h.network.socketBoundaries.slice(firstSocketIndex);
        await vi.waitFor(() => expect(sockets().some(boundary => boundary.socket.connected)).toBe(true));
        expect(sockets()).toHaveLength(1);

        const requestCanonical = createServerFetchAtEndpoint({
            endpointUrl: h.homeA.serverUrl, runtimeOrigin: h.homeA.serverUrl,
            credentials: { token: h.homeA.token }, serverId: h.homeA.id,
            superviseReachability: true,
        });
        const shutdowns: string[] = [];
        const connectedWakes: string[] = [];
        const reconnectSignals: number[] = [];
        const releaseReachability = h.pool.subscribeServerReachabilityState(h.homeA.serverUrl,
            state => { if (state.phase === 'shutting_down') shutdowns.push(state.phase); }, h.homeA.token);
        const releaseWakes = subscribeHomeAccountChange(event => {
            if (event.serverId === h.homeA.id && event.source === 'connected') connectedWakes.push(event.serverId);
        }, { reconnect: 'refresh' });
        const releaseReconnect = apiSocket.onReconnected(() => { reconnectSignals.push(Date.now()); });
        vi.useFakeTimers();
        try {
            // One settled minute of genuine, healthy reads. The duration is a
            // fixture workload, not a new timeout or retry policy.
            for (let second = 0; second < 60; second += 1) {
                expect((await requestCanonical('/v1/deployments/projects/source-a')).status).toBe(200);
                expect((await apiSocket.request('/v1/deployments/projects/source-a')).status).toBe(200);
                await vi.advanceTimersByTimeAsync(1_000);
            }
            const observed = { physicalSockets: sockets().length, shutdowns: shutdowns.length,
                reconnectSignals: reconnectSignals.length, connectedWakes: connectedWakes.length };
            console.info('same-Home healthy transport selection per settled minute', observed);
            expect(observed).toEqual({ physicalSockets: 1, shutdowns: 0, reconnectSignals: 0, connectedWakes: 0 });
        } finally {
            releaseReconnect();
            releaseWakes();
            releaseReachability();
        }
    });
});
