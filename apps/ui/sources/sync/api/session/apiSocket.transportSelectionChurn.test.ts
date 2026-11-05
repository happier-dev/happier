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
