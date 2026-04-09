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
const useSessionExecutionRunsSupportedSpy = vi.hoisted(() =>
    vi.fn((_sessionId: string, _serverId?: string | null) => true),
);
const preferredServerIdState = vi.hoisted(() => ({
    value: 'server-canonical' as string | null,
}));

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
    useExecutionRunsBackendsForSession: (sessionId: string, serverId?: string | null) =>
        useExecutionRunsBackendsForSessionSpy(sessionId, serverId),
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string, serverId?: string | null) =>
        useSessionExecutionRunsSupportedSpy(sessionId, serverId),
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: [] }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (sessionId: string, fallbackServerId?: string | null) => {
        resolveSessionTargetServerIdSpy(sessionId, fallbackServerId);
        return preferredServerIdState.value ?? fallbackServerId ?? null;
    },
}));

vi.mock('@/components/sessions/model/useSessionDirectSessionRuntime', () => ({
    useSessionDirectSessionRuntime: () => ({
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
        useSessionExecutionRunsSupportedSpy.mockReset();
        preferredServerIdState.value = 'server-canonical';
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

    it('refreshes backend lookup when the preferred session server changes', async () => {
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook((session: typeof sessionState.value) => useSessionExecutionRunLaunchability('session-1', session), {
            initialProps: sessionState.value,
        });

        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenLastCalledWith('session-1', 'server-canonical');

        preferredServerIdState.value = 'server-updated';
        await hook.rerender(sessionState.value);

        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenLastCalledWith('session-1', 'server-updated');

        await hook.unmount();
    });

    it('falls back to the direct session server id while the preferred server lookup is unresolved', async () => {
        preferredServerIdState.value = null;

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(hook.getCurrent().sessionServerId).toBe('server-explicit');

        await hook.unmount();
    });
});
