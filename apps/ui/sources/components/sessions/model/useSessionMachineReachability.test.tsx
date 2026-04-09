import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    void importOriginal;
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                sessions: storageState.sessions,
                machines: Object.fromEntries(storageState.machines.map((machine) => [machine.id, machine])),
                getProjectForSession: (sessionId: string) => storageState.projects[sessionId as keyof typeof storageState.projects] ?? null,
            }),
        },
        useSession: (sessionId: string) => storageState.sessions[sessionId as keyof typeof storageState.sessions] ?? null,
        useProjectForSession: (sessionId: string) => storageState.projects[sessionId as keyof typeof storageState.projects] ?? null,
        useAllMachines: () => storageState.machines,
        useAllSessions: () => Object.values(storageState.sessions),
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
});
