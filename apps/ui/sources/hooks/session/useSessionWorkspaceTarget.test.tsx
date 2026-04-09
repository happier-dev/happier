import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useSessionWorkspaceTarget } from './useSessionWorkspaceTarget';

const activeServerState = vi.hoisted(() => {
    const listeners = new Set<(snapshot: { serverId: string; serverUrl: string; generation: number }) => void>();
    return {
        snapshot: { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 },
        listeners,
        setSnapshot(next: { serverId: string; serverUrl: string; generation: number }) {
            this.snapshot = next;
            for (const listener of listeners) {
                listener(next);
            }
        },
        reset() {
            this.snapshot = { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 };
            listeners.clear();
        },
    };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.snapshot,
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        activeServerState.listeners.add(listener);
        listener(activeServerState.snapshot);
        return () => {
            activeServerState.listeners.delete(listener);
        };
    },
}));

describe('useSessionWorkspaceTarget', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
        activeServerState.reset();
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                s1: createSessionFixture({
                    id: 's1',
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                        host: 'machine.local',
                        homeDir: '/Users/tester',
                    } as any,
                }),
            },
            machines: {
                ...state.machines,
                'machine-1': createMachineFixture({
                    id: 'machine-1',
                    active: true,
                    metadata: {
                        host: 'machine.local',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/Users/tester/.happy-dev',
                        homeDir: '/Users/tester',
                    } as any,
                }),
            },
            getProjectForSession: () => null,
        }));
    });

    afterEach(() => {
        storage.setState(previousState);
        standardCleanup();
    });

    it('recomputes the workspace target when the active server changes', async () => {
        const hook = await renderHook(() => useSessionWorkspaceTarget('  s1  '));

        expect(hook.getCurrent()).toEqual({
            workspaceCacheKey: 'server-a:machine-1:/repo',
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-a',
        });

        await act(async () => {
            activeServerState.setSnapshot({
                serverId: 'server-b',
                serverUrl: 'https://b.example.test',
                generation: 2,
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toEqual({
            workspaceCacheKey: 'server-b:machine-1:/repo',
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-b',
        });

        await hook.unmount();
    });
});
