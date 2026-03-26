import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: {
                    connected: '#00ff00',
                    connecting: '#ffcc00',
                    actionRequired: '#ff9900',
                    disconnected: '#999999',
                    error: '#ff0000',
                    default: '#999999',
                },
            },
        },
    });
});

vi.mock('@/components/settings/server/hooks/useActiveSelectionMachineGroups', () => ({
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
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ generation: 1 }),
    listServerProfiles: () => [],
}));

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

vi.mock('@/sync/domains/state/storage', async () => {
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
