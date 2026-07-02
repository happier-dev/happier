import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useShouldBlockNewSessionWithGettingStartedGuidance } from './useShouldBlockNewSessionWithGettingStartedGuidance';

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: null,
    }),
}));

afterEach(() => {
    standardCleanup();
});

function createMachine(id: string, activeAt: number): Machine {
    return {
        id,
        seq: 1,
        createdAt: activeAt,
        updatedAt: activeAt,
        active: true,
        activeAt,
        revokedAt: null,
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/home/me/.happier',
            homeDir: '/home/me',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('useShouldBlockNewSessionWithGettingStartedGuidance', () => {
    it('stays stable when the active machine only receives heartbeat timestamps', async () => {
        const previousState = storage.getState();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const machine = createMachine('machine-online', 1000);
        let renderCount = 0;

        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: true,
                    machines: {
                        [machine.id]: machine,
                    },
                    machineListByServerId: activeServerId
                        ? {}
                        : state.machineListByServerId,
                }));
            });

            const hook = await renderHook(() => {
                renderCount += 1;
                return useShouldBlockNewSessionWithGettingStartedGuidance();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(false);
            const settledRenderCount = renderCount;
            expect(settledRenderCount).toBeGreaterThan(0);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        ...state.machines,
                        [machine.id]: {
                            ...state.machines[machine.id]!,
                            updatedAt: 2000,
                            activeAt: 2000,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(false);
            expect(renderCount).toBe(settledRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
