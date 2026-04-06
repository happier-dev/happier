import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { installServerHookCommonModuleMocks } from '../server/serverHookModuleTestHelpers';

const resolveSessionTargetServerIdSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string, fallbackServerId?: string | null) => string | null>(() => 'server-canonical'),
);
const useExecutionRunsBackendsForSessionSpy = vi.hoisted(() =>
    vi.fn((..._args: unknown[]) => ({ claude: { available: true, intents: ['review'] } })),
);

const sessionState = vi.hoisted(() => ({
    value: {
        id: 'session-1',
        active: true,
        serverId: 'server-explicit',
        metadata: { flavor: 'claude' },
    } as any,
}));

installServerHookCommonModuleMocks({
    storage: async () => createStorageModuleStub({
        useSession: () => sessionState.value,
        useProjectForSession: () => null,
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/server/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true }),
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: (...args: unknown[]) => useExecutionRunsBackendsForSessionSpy(...args),
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => true,
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: [] }),
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (...args: unknown[]) =>
        resolveSessionTargetServerIdSpy(args[0] as string, args[1] as string | null | undefined),
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => ({
        directSessionLink: null,
        status: { runnerActive: true },
    }),
}));

vi.mock('@/sync/domains/executionRuns/canLaunchExecutionRunsForSession', () => ({
    canLaunchExecutionRunsForSession: () => true,
}));

vi.mock('@/sync/domains/session/directSessions/resolveSessionMachineId', () => ({
    resolveSessionMachineId: () => 'machine-1',
}));

describe('useSessionExecutionRunLaunchability', () => {
    afterEach(() => {
        standardCleanup();
        resolveSessionTargetServerIdSpy.mockReset();
        useExecutionRunsBackendsForSessionSpy.mockReset();
        sessionState.value = {
            id: 'session-1',
            active: true,
            serverId: 'server-explicit',
            metadata: { flavor: 'claude' },
        } as any;
    });

    it('exposes the canonical session server id for consumers and backend lookup', async () => {
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(resolveSessionTargetServerIdSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('session-1', 'server-canonical');
        expect(hook.getCurrent()).toMatchObject({
            sessionServerId: 'server-canonical',
            executionRunsSupported: true,
            executionRunsBackends: { claude: { available: true, intents: ['review'] } },
        });

        await hook.unmount();
    });
});
