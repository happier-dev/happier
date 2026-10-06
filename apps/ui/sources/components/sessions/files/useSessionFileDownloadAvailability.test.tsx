import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { recordCachedMachineRpcDirectRouteViable } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { installTransferProjection, resetTransferFixture, transferMachine } from './sessionFileTransferTestkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit');
    return createReactNativeWebMock();
});

describe('useSessionFileDownloadAvailability', () => {
    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await resetTransferFixture();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('fails closed when server-routed is disabled and the current Machine endpoint is unknown', async () => {
        installTransferProjection({ machine: transferMachine({ operationProtocolCapabilities: { finiteTransferRpc: { protocolVersions: [1] } } }) });
        recordCachedMachineRpcDirectRouteViable({ serverId: 'server-1', remoteMachineId: 'machine-1' });
        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('returns true when server-routed is disabled and the current Machine carrier is available', async () => {
        installTransferProjection();
        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
    });

    it('upload fails closed when server-routed is disabled and the current Machine endpoint is unknown', async () => {
        installTransferProjection({ machine: transferMachine({ operationProtocolCapabilities: { finiteTransferRpc: { protocolVersions: [1] } } }) });
        recordCachedMachineRpcDirectRouteViable({ serverId: 'server-1', remoteMachineId: 'machine-1' });
        const { useSessionFileUploadAvailability } = await import('./useSessionFileUploadAvailability');
        const hook = await renderHook(() => useSessionFileUploadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('upload returns true when server-routed is disabled and the current Machine carrier is available', async () => {
        installTransferProjection();
        const { useSessionFileUploadAvailability } = await import('./useSessionFileUploadAvailability');
        const hook = await renderHook(() => useSessionFileUploadAvailability('s1'));
        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
    });
});
