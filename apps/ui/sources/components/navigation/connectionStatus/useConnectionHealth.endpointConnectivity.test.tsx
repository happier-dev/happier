import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { installConnectionStatusCommonModuleMocks } from './connectionStatusTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connectionState = vi.hoisted(() => ({
    endpointStatus: 'online' as import('@happier-dev/connection-supervisor').ManagedConnectionPhase,
    socketStatus: 'connected' as import('./connectionHealthTypes').ConnectionSocketStatus,
    hasSyncError: false,
    machines: [] as Array<Record<string, unknown>>,
}));
const activeServerState = vi.hoisted(() => ({
    snapshot: { serverId: 'server-a', generation: 1 } as { serverId: string; generation: number },
    listeners: new Set<() => void>(),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => {
        const [snapshot, setSnapshot] = React.useState(activeServerState.snapshot);

        React.useEffect(() => {
            const listener = () => setSnapshot({ ...activeServerState.snapshot });
            activeServerState.listeners.add(listener);
            return () => {
                activeServerState.listeners.delete(listener);
            };
        }, []);

        return snapshot;
    },
}));

installConnectionStatusCommonModuleMocks({
    activeSelectionMachineGroups: () => ({
        useActiveSelectionMachineGroups: () => ({
            visibleMachineGroups: [
                {
                    status: 'idle',
                    machines: activeServerState.snapshot.serverId === 'server-b'
                        ? [
                            {
                                id: 'm2',
                                active: true,
                                activeAt: Date.now(),
                                revokedAt: null,
                                metadata: { host: 'beta' },
                                daemonState: { status: 'running' },
                            },
                        ]
                        : connectionState.machines,
                },
            ],
        }),
    }),
    serverProfiles: () => ({
        getActiveServerSnapshot: () => activeServerState.snapshot,
        listServerProfiles: () => [{ id: 'server-a', name: 'Server A', serverUrl: 'https://api.example.test' }],
    }),
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useEndpointConnectivity: () => ({
                status: connectionState.endpointStatus,
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            useSocketStatus: () => ({ status: connectionState.socketStatus }),
            useSyncError: () => (connectionState.hasSyncError ? ({ message: 'boom', retryable: true, kind: 'network', at: Date.now() } as any) : null),
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSetting: () => null,
        });
    },
});

describe('useConnectionHealth (endpoint connectivity integration)', () => {
    it('prioritizes endpoint offline over socket connected + sync errors', async () => {
        connectionState.endpointStatus = 'offline';
        connectionState.socketStatus = 'connected';
        connectionState.hasSyncError = true;
        connectionState.machines = [];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('server_unreachable');
    });

    it('surfaces auth_required when endpoint auth_failed', async () => {
        connectionState.endpointStatus = 'auth_failed';
        connectionState.socketStatus = 'connected';
        connectionState.hasSyncError = false;
        connectionState.machines = [];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('auth_required');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
    });

    it('surfaces machine_not_ready when machines are online but none are ready', async () => {
        connectionState.endpointStatus = 'online';
        connectionState.socketStatus = 'connected';
        connectionState.hasSyncError = false;
        connectionState.machines = [
            { id: 'm1', active: true, activeAt: Date.now(), revokedAt: null, daemonState: { status: 'offline' } },
            { id: 'm2', active: true, activeAt: Date.now(), revokedAt: null, daemonState: { status: 'offline' } },
        ];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('machine_not_ready');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
        expect(hook.getCurrent().machineLabelKey).toBe('status.online');
    });

    it('exposes primaryMachineLabel when exactly one machine is visible', async () => {
        connectionState.endpointStatus = 'online';
        connectionState.socketStatus = 'connected';
        connectionState.hasSyncError = false;
        connectionState.machines = [
            {
                id: 'm1',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: { host: 'mbp' },
                daemonState: { status: 'running' },
            },
        ];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().primaryMachineLabel).toBe('mbp');
    });

    it('updates when the active server snapshot changes', async () => {
        connectionState.endpointStatus = 'online';
        connectionState.socketStatus = 'connected';
        connectionState.hasSyncError = false;
        connectionState.machines = [
            {
                id: 'm1',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: { host: 'alpha' },
                daemonState: { status: 'running' },
            },
        ];
        activeServerState.snapshot = { serverId: 'server-a', generation: 1 };

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());
        await flushHookEffects();

        expect(hook.getCurrent().primaryMachineLabel).toBe('alpha');

        await act(async () => {
            activeServerState.snapshot = { serverId: 'server-b', generation: 2 };
            for (const listener of activeServerState.listeners) {
                listener();
            }
        });
        await flushHookEffects();

        expect(hook.getCurrent().primaryMachineLabel).toBe('beta');
    });
});
