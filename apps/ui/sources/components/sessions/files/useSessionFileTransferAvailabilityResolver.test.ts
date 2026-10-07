import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, createSessionFixture, renderHook } from '@/dev/testkit';
import { setActiveServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { recordCachedMachineRpcDirectRouteViable } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { probeIrohMachineTransferLifecycleAvailability } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { installTransferProjection, resetTransferFixture, transferFeatures, transferMachine } from './sessionFileTransferTestkit';
import { useSessionFileTransferAvailabilityResolver, useSessionFileTransferAvailabilityState } from './useSessionFileTransferAvailability';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('useSessionFileTransferAvailabilityResolver', () => {
    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await resetTransferFixture();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reactively enables an Iroh-only native transfer after the host lifecycle probe succeeds', async () => {
        const availability = createDeferred<{ available: boolean }>();
        const invoke = vi.fn((command: string) => {
            expect(command).toBe('iroh_get_availability');
            return availability.promise;
        });
        // The physical desktop command bridge is the availability boundary.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        installTransferProjection();
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(null)).toBe(false);
        expect(invoke).toHaveBeenCalled();
        await act(async () => {
            availability.resolve({ available: true });
            await probeIrohMachineTransferLifecycleAvailability();
        });
        expect(hook.getCurrent()(null)).toBe(true);
        await hook.unmount();
    });

    it('does not gate bulk file transfers by the total transfer size (chunked transfers)', async () => {
        installTransferProjection({ machine: transferMachine({ id: 'runner-1', kind: 'ephemeral_session_runner', daemonState: null }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(64)).toBe(true);
        expect(hook.getCurrent()(512)).toBe(true);
        await hook.unmount();
    });

    it('keeps a current Runner unavailable without its current Iroh endpoint', async () => {
        installTransferProjection({ machine: transferMachine({
            id: 'runner-1', kind: 'ephemeral_session_runner', daemonState: null,
            operationProtocolCapabilities: { finiteTransferRpc: { protocolVersions: [1] } },
        }) });
        recordCachedMachineRpcDirectRouteViable({ serverId: 'server-1', remoteMachineId: 'runner-1' });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityState('s1'));
        expect(hook.getCurrent().available).toBe(false);
        expect(hook.getCurrent().decision).toBeNull();
        await hook.unmount();
    });

    it('keeps the resolver stable while availability inputs stay unchanged', async () => {
        installTransferProjection();
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        const initialResolver = hook.getCurrent();
        await hook.rerender();
        expect(hook.getCurrent()).toBe(initialResolver);
        await hook.unmount();
    });

    it('allows session file transfers when the current daemon endpoint and direct peer are enabled', async () => {
        installTransferProjection({ machine: transferMachine({ daemonState: { transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: true, configured: true, active: true },
                tailscale_serve_https: { enabled: false, configured: false, active: false, available: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } } }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(64)).toBe(true);
        await hook.unmount();
    });

    it('exposes coarse daemon direct-peer diagnostics for configured-but-inactive listeners', async () => {
        installTransferProjection({ machine: transferMachine({ daemonState: { transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: true, configured: true, active: false },
                tailscale_serve_https: { enabled: true, configured: true, active: false, available: true },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } } }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityState('s1'));
        expect(hook.getCurrent().daemonDirectPeerDiagnostics).toEqual({
            route: { status: 'unknown' }, state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            activeListenerClasses: [], activeRouteKinds: [],
            inactiveListenerClasses: ['loopback_http', 'tailscale_serve_https'], unavailableListenerClasses: [],
        });
        expect(hook.getCurrent().available).toBe(true);
        await hook.unmount();
    });

    it('uses the preferred server scoped machine daemon state instead of the active global machine record', async () => {
        installTransferProjection({ machine: transferMachine(), globalMachine: transferMachine({ operationProtocolCapabilities: {}, daemonState: null }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1', 'server-1'));
        expect(hook.getCurrent()(64)).toBe(true);
        await hook.unmount();
    });

    it('uses the explicit session server id when bare-id preferred server resolution is ambiguous', async () => {
        installTransferProjection({ serverId: 'server-explicit' });
        storage.setState({ ordinarySessionListMembershipByServerId: { 'server-1': ['s1'], 'server-explicit': ['s1'] } });
        const bare = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        const exact = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1', 'server-explicit'));
        expect(bare.getCurrent()(64)).toBe(false);
        expect(exact.getCurrent()(64)).toBe(true);
        await bare.unmount();
        await exact.unmount();
    });

    it('does not infer an unhydrated session Home from active server changes and reacts when its Home is hydrated', async () => {
        installTransferProjection({ session: createSessionFixture({ id: 's1', active: true }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(64)).toBe(false);
        await act(async () => { await setActiveServer({ serverId: 'server-b' }); });
        expect(hook.getCurrent()(64)).toBe(false);
        await act(async () => installTransferProjection({ serverId: 'server-b' }));
        expect(hook.getCurrent()(64)).toBe(true);
        await hook.unmount();
    });

    it('uses the active global machine projection when its scoped machine list is not loaded, but never for another Home', async () => {
        const machine = transferMachine();
        installTransferProjection({ machine });
        storage.setState({ machineListByServerId: { 'server-1': null } });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1', 'server-1'));
        expect(hook.getCurrent()(64)).toBe(true);
        await act(async () => {
            storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-b', active: true }) } });
        });
        const remote = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1', 'server-b'));
        expect(remote.getCurrent()(64)).toBe(false);
        await hook.unmount();
        await remote.unmount();
    });

    it('fails closed when file transfer policy has no viable route', async () => {
        installTransferProjection({ features: transferFeatures({ transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } } }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(64)).toBe(false);
        await act(async () => installTransferProjection({ features: transferFeatures({ peerMediation: { enabled: false, observability: { enabled: false } } }) }));
        expect(hook.getCurrent()(64)).toBe(false);
        await hook.unmount();
    });

    it('fails closed when machine transfers are disabled on the server', async () => {
        installTransferProjection({ features: transferFeatures({ transfer: { enabled: false, directPeer: { enabled: true }, serverRouted: { enabled: true } } }) });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(64)).toBe(false);
        await hook.unmount();
    });

    it('fails closed when the session record is missing (no speculative transfer availability)', async () => {
        installTransferProjection({ session: null });
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));
        expect(hook.getCurrent()(null)).toBe(false);
        await hook.unmount();
    });
});
