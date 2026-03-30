import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectionStatusCommonModuleMocks } from './connectionStatusTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const socketStatusMock = vi.hoisted(() => vi.fn(() => ({ status: 'connected' })));
const endpointConnectivityMock = vi.hoisted(() =>
    vi.fn(() => ({
        status: 'offline',
        reason: null,
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    })),
);

installConnectionStatusCommonModuleMocks({
    activeSelectionMachineGroups: () => ({
        useActiveSelectionMachineGroups: () => ({
            visibleMachineGroups: [
                {
                    status: 'idle',
                    machines: [
                        { id: 'm1', active: true, activeAt: Date.now(), revokedAt: null },
                        { id: 'm2', active: true, activeAt: Date.now(), revokedAt: null },
                    ],
                },
            ],
        }),
    }),
    serverProfiles: () => ({
        getActiveServerSnapshot: () => ({ generation: 1 }),
        listServerProfiles: () => [],
    }),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSocketStatus: () => socketStatusMock(),
            useEndpointConnectivity: () => endpointConnectivityMock(),
            useSyncError: () => null,
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSetting: () => null,
        });
    },
});

describe('useConnectionHealth (endpoint status)', () => {
    it('prioritizes endpoint offline over a stale connected socket status', async () => {
        const { useConnectionHealth } = await import('./useConnectionHealth');

        let value: any = null;
        function Probe() {
            value = useConnectionHealth();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        expect(value.kind).toBe('server_unreachable');
    });
});
