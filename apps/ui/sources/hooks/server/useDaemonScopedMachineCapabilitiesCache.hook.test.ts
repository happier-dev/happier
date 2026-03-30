import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installServerHookCommonModuleMocks } from './serverHookModuleTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineCapabilitiesCacheMock = vi.fn();

installServerHookCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useMachine: vi.fn((machineId: string) => (
                machineId === 'm1' ? { id: 'm1', metadata: {}, daemonStateVersion: 7 } : null
            )),
        });
    },
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (...args: any[]) => useMachineCapabilitiesCacheMock(...args),
    };
});

describe('useDaemonScopedMachineCapabilitiesCache (hook)', () => {
    async function renderHookState(run: () => unknown) {
        let latest: unknown = null;
        function Test() {
            latest = run();
            return React.createElement('View');
        }
        const screen = await renderScreen(React.createElement(Test));
        await screen.unmount();
        return latest as any;
    }

    it('uses daemonStateVersion as cacheKeySalt when available', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: { status: 'idle' }, refresh: vi.fn() });

        const { useDaemonScopedMachineCapabilitiesCache } = await import('./useDaemonScopedMachineCapabilitiesCache');

        await renderHookState(() => useDaemonScopedMachineCapabilitiesCache({
            machineId: 'm1',
            enabled: false,
            request: { checklistId: 'new-session' } as any,
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.cacheKeySalt).toBe(7);
    });

    it('prefers explicit daemonStateVersion override when provided', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: { status: 'idle' }, refresh: vi.fn() });

        const { useDaemonScopedMachineCapabilitiesCache } = await import('./useDaemonScopedMachineCapabilitiesCache');

        await renderHookState(() => useDaemonScopedMachineCapabilitiesCache({
            machineId: 'm1',
            enabled: false,
            daemonStateVersion: 123,
            request: { checklistId: 'new-session' } as any,
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.cacheKeySalt).toBe(123);
    });
});
