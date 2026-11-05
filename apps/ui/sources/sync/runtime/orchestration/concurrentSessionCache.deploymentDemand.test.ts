import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('deployment-demand');
const { subscribeHomeAccountChange } = await import('./homeAccountChange');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

describe('deployment Home connection demand', () => {
    it('backs off failed namespace admission on a demanded other Home instead of restarting its supervisor', async () => {
        await h.select([h.homeA.id]);
        const release = subscribeHomeAccountChange(() => {}, { serverIds: [h.homeC.id] });
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
        // Simulate a reachable byte transport that closes before namespace CONNECT.
        h.network.setSocketConfigurator(boundary => {
            if (boundary.serverUrl !== h.homeC.serverUrl) return;
            boundary.socket.connect.mockImplementation(() => {
                boundary.socket.active = true;
                queueMicrotask(() => boundary.trigger('connect_error', new Error('namespace admission unavailable')));
            });
        });
        const sockets = () => h.network.socketBoundaries.filter(socket => socket.serverUrl === h.homeC.serverUrl);
        vi.useFakeTimers();
        try {
            h.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(sockets()).toHaveLength(1));
            await vi.advanceTimersByTimeAsync(60_000);
            // Existing policy: initial, 250ms, 2.25s, 6.25s, 14.25s, 30.25s.
            expect(sockets()).toHaveLength(6);
            release();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(sockets()).toHaveLength(6);
            expect(sockets().every(socket => !socket.socket.active)).toBe(true);
            expect(h.requests('/v2/sessions')).toHaveLength(0);
            expect(h.requests('/v1/machines')).toHaveLength(0);
        } finally {
            release();
            h.stopConcurrentSessionCacheSync();
            random.mockRestore();
            vi.useRealTimers();
        }
    });
    it('opens no new sockets per settled minute for a hidden deployment reader on an unselected Home that never acknowledges CONNECT', async () => {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { useDeploymentProject } = await import('@/components/projects/deployments/useDeploymentProject');
        const { SERVER_PEER_LIVENESS_WINDOW_MS } = await import('@/sync/runtime/connectivity/serverReachabilityTuning');
        await h.select([h.homeA.id]);
        const account = await captureLazyActionAccountContext(h.homeC.id);
        // The external transport opens, but this Home never admits its Socket.IO namespace.
        // Keep the actual adapter, reachability owner and reconnect supervisor beneath it.
        h.network.setSocketConfigurator(boundary => {
            if (boundary.serverUrl !== h.homeC.serverUrl) return;
            boundary.socket.connect.mockImplementation(() => { boundary.socket.active = true; });
        });
        const hook = await renderHook((visible: boolean) => useDeploymentProject(account.accountLifetime, 'source-c',
            { mounted: true, visible, focused: true }), { initialProps: true });
        const sockets = () => h.network.socketBoundaries.filter(socket => socket.serverUrl === h.homeC.serverUrl);
        vi.useFakeTimers();
        try {
            h.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(sockets()).toHaveLength(1));
            const pending = sockets()[0]!;
            await vi.advanceTimersByTimeAsync(SERVER_PEER_LIVENESS_WINDOW_MS - 1_000);
            expect(sockets()).toHaveLength(1);
            expect(pending.socket.connected).toBe(false);
            await hook.rerender(false);
            // Two settled minutes cross the real namespace timeout and retry boundary.
            await vi.advanceTimersByTimeAsync(2 * SERVER_PEER_LIVENESS_WINDOW_MS);
            expect(sockets(), 'hidden retained controllers must create zero new physical sockets').toHaveLength(1);
            expect(pending.socket.active).toBe(false);
        } finally {
            h.stopConcurrentSessionCacheSync();
            vi.useRealTimers();
            await hook.unmount();
            account.dispose();
        }
    });
});
