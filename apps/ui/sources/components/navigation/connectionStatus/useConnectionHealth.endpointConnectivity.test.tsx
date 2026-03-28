import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { installConnectionStatusCommonModuleMocks } from './connectionStatusTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let endpointStatus: import('@happier-dev/connection-supervisor').ManagedConnectionPhase = 'online';
let socketStatus: import('./connectionHealthTypes').ConnectionSocketStatus = 'connected';
let hasSyncError: boolean = false;

installConnectionStatusCommonModuleMocks({
    activeSelectionMachineGroups: () => ({
        useActiveSelectionMachineGroups: () => ({
            visibleMachineGroups: [{ status: 'idle', machines: [] }],
        }),
    }),
    serverProfiles: () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server-a', generation: 1 }),
        listServerProfiles: () => [{ id: 'server-a', name: 'Server A', serverUrl: 'https://api.example.test' }],
    }),
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useEndpointConnectivity: () => ({
                status: endpointStatus,
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            useSocketStatus: () => ({ status: socketStatus }),
            useSyncError: () => (hasSyncError ? ({ message: 'boom', retryable: true, kind: 'network', at: Date.now() } as any) : null),
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSetting: () => null,
        });
    },
});

describe('useConnectionHealth (endpoint connectivity integration)', () => {
    it('prioritizes endpoint offline over socket connected + sync errors', async () => {
        endpointStatus = 'offline';
        socketStatus = 'connected';
        hasSyncError = true;

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('server_unreachable');
    });

    it('surfaces auth_required when endpoint auth_failed', async () => {
        endpointStatus = 'auth_failed';
        socketStatus = 'connected';
        hasSyncError = false;

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('auth_required');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
    });
});
