import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

type StorageModule = typeof import('@/sync/domains/state/storage');

const nowMs = Date.now();
const storageState = {
    sessions: {
        s1: {
            active: true,
            metadata: {
                machineId: 'm1',
                path: '/repo',
                homeDir: '/repo',
            },
        },
    },
    machines: [
        {
            id: 'm1',
            active: true,
            activeAt: nowMs,
            metadata: { host: 'host-1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/repo', homeDir: '/repo' },
        },
    ],
    projects: {
        s1: { key: { machineId: 'm1', rootPath: '/repo' } },
    },
};
const storageListeners = new Set<() => void>();
let allSessionsSnapshot = Object.values(storageState.sessions);

function emitStorageChange() {
    allSessionsSnapshot = Object.values(storageState.sessions);
    for (const listener of storageListeners) {
        listener();
    }
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    void importOriginal;
    const React = await import('react');
    const subscribe = (listener: () => void) => {
        storageListeners.add(listener);
        return () => {
            storageListeners.delete(listener);
        };
    };
    const buildState = () => ({
        sessions: storageState.sessions,
        machines: Object.fromEntries(storageState.machines.map((machine) => [machine.id, machine])),
        getProjectForSession: (sessionId: string) => storageState.projects[sessionId as keyof typeof storageState.projects] ?? null,
    });
    return createStorageModuleStub({
        getStorage: () => ((selector?: (state: unknown) => unknown) => React.useSyncExternalStore(
            subscribe,
            () => {
                const state = buildState();
                return typeof selector === 'function' ? selector(state) : state;
            },
            () => {
                const state = buildState();
                return typeof selector === 'function' ? selector(state) : state;
            },
        )) as ReturnType<StorageModule['getStorage']>,
        storage: {
            getState: buildState,
        },
        useSession: (sessionId: string) => storageState.sessions[sessionId as keyof typeof storageState.sessions] ?? null,
        useProjectForSession: (sessionId: string) => storageState.projects[sessionId as keyof typeof storageState.projects] ?? null,
        useAllMachines: () => storageState.machines,
        useMachine: (machineId: string) => React.useSyncExternalStore(
            subscribe,
            () => storageState.machines.find((machine) => machine.id === machineId) ?? null,
            () => storageState.machines.find((machine) => machine.id === machineId) ?? null,
        ),
        useAllSessions: () => React.useSyncExternalStore(
            subscribe,
            () => allSessionsSnapshot,
            () => allSessionsSnapshot,
        ),
    });
});

describe('useSessionMachineReachability', () => {
    it('normalizes session ids before resolving the reachable machine target', async () => {
        const { useSessionReachableMachineTarget } = await import('./useSessionMachineReachability');
        const hook = await renderHook(() => useSessionReachableMachineTarget('  s1  '));

        expect(hook.getCurrent()).toEqual({
            machineId: 'm1',
            basePath: '/repo',
        });

        await hook.unmount();
    });

    it('normalizes session ids before resolving machine reachability', async () => {
        const { useSessionMachineReachability } = await import('./useSessionMachineReachability');
        const hook = await renderHook(() => useSessionMachineReachability('  s1  '));

        expect(hook.getCurrent()).toEqual({
            machineReachable: true,
            machineOnline: true,
            machineRpcTargetAvailable: true,
        });

        await hook.unmount();
    });

    it('does not update the visible session reachability when an unrelated background session changes', async () => {
        const { useSessionMachineReachability } = await import('./useSessionMachineReachability');
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1');
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return value;
        });

        expect(seen).toHaveLength(1);

        await act(async () => {
            (storageState.sessions as Record<string, any>).background = {
                active: true,
                metadata: {
                    machineId: 'm1',
                    path: '/other-repo',
                    homeDir: '/repo',
                },
            };
            emitStorageChange();
        });
        await flushHookEffects();

        expect(seen).toHaveLength(1);

        await hook.unmount();
    });

    it('does not update visible reachability when only the machine heartbeat changes', async () => {
        const { useSessionMachineReachability } = await import('./useSessionMachineReachability');
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1');
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return value;
        });

        expect(seen).toHaveLength(1);

        await act(async () => {
            (storageState.machines as any[])[0] = {
                ...storageState.machines[0],
                activeAt: nowMs + 1,
                lastSeenMs: nowMs + 1,
            };
            emitStorageChange();
        });
        await flushHookEffects();

        expect(seen).toHaveLength(1);

        await hook.unmount();
    });
});
