import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { createDeferred, createSessionFixture, renderHook } from '@/dev/testkit';
import { deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { recordCachedMachineRpcDirectRouteUnavailable, recordCachedMachineRpcDirectRouteViable } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installTransferProjection, resetTransferFixture, transferMachine } from './sessionFileTransferTestkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('useSessionFileDownloadAvailability', () => {
    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await resetTransferFixture();
    });
    afterEach(() => { resetRuntimeFetch(); vi.unstubAllGlobals(); });

    it('reacts to current endpoint projection changes without trusting cached legacy direct-route viability', async () => {
        const machine = transferMachine({ operationProtocolCapabilities: { finiteTransferRpc: { protocolVersions: [1] } } });
        installTransferProjection({ machine });
        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);

        await act(async () => recordCachedMachineRpcDirectRouteViable({ serverId: 'server-1', remoteMachineId: machine.id }));
        await hook.rerender();
        expect(hook.getCurrent()).toBe(false);

        await act(async () => installTransferProjection({ machine: transferMachine() }));
        expect(hook.getCurrent()).toBe(true);
        await act(async () => installTransferProjection({ machine }));
        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('fails closed when server feature snapshot is not ready (even if a machine target exists)', async () => {
        installTransferProjection();
        deleteServerFeaturesSnapshot({ serverId: 'server-1' });
        // The remote Home has not answered its feature request yet.
        const response = createDeferred<Response>();
        setRuntimeFetch(() => response.promise);
        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        try {
            expect(hook.getCurrent()).toBe(false);
        } finally {
            await hook.unmount();
            // Finish the physical request so its real owner can release its deadline.
            await act(async () => response.resolve(new Response('{}', { status: 404 })));
        }
    });

    it('hides download actions when direct mode is unreachable and session RPC is unavailable', async () => {
        installTransferProjection({
            session: createSessionFixture({ id: 's1', serverId: 'server-1', active: false }),
            machine: transferMachine({ operationProtocolCapabilities: {} }),
        });
        recordCachedMachineRpcDirectRouteUnavailable({ serverId: 'server-1', remoteMachineId: 'machine-1' }, 'machine_rpc_direct_unavailable');
        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });
});
