import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { installServerHookCommonModuleMocks } from '../server/serverHookModuleTestHelpers';

const resolveSessionTargetServerIdSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string, fallbackServerId?: string | null) => string | null>(() => 'server-canonical'),
);
const useExecutionRunsBackendsForSessionSpy = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => { claude: { available: true; intents: ['review'] } }>(
        () => ({ claude: { available: true, intents: ['review'] } }),
    ),
);
const useSessionExecutionRunsSupportedSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string, serverId?: string | null) => boolean>(() => true),
);
const resumeCapabilityOptionsSpy = vi.hoisted(() =>
    vi.fn<(args: unknown) => { resumeCapabilityOptions: unknown }>(() => ({ resumeCapabilityOptions: [] })),
);
const canLaunchExecutionRunsForSessionSpy = vi.hoisted(() => vi.fn());
const preferredServerIdState = vi.hoisted(() => ({
    value: 'server-canonical' as string | null,
}));
const sessionMachineTargetState = vi.hoisted(() => ({
    value: null as null | { machineId: string; basePath: string },
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

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => sessionMachineTargetState.value,
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
    useResumeCapabilityOptions: (args: unknown) => resumeCapabilityOptionsSpy(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (sessionId: string, fallbackServerId?: string | null) => {
        resolveSessionTargetServerIdSpy(sessionId, fallbackServerId);
        return preferredServerIdState.value ?? fallbackServerId ?? null;
    },
}));

vi.mock('@/components/sessions/model/useSessionExternalSessionRuntime', () => ({
    useSessionExternalSessionRuntime: () => ({
        externalSessionLink: null,
        status: { runnerActive: true },
    }),
}));

vi.mock('@/sync/domains/executionRuns/canLaunchExecutionRunsForSession', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/executionRuns/canLaunchExecutionRunsForSession')>();
    return {
        ...actual,
        canLaunchExecutionRunsForSession: (input: Parameters<typeof actual.canLaunchExecutionRunsForSession>[0]) => {
            canLaunchExecutionRunsForSessionSpy(input);
            return actual.canLaunchExecutionRunsForSession(input);
        },
    };
});

vi.mock('@/sync/domains/session/external/resolveSessionMachineId', () => ({
    resolveSessionMachineId: () => 'machine-1',
}));

describe('useSessionExecutionRunLaunchability', () => {
    afterEach(() => {
        standardCleanup();
        resolveSessionTargetServerIdSpy.mockReset();
        useExecutionRunsBackendsForSessionSpy.mockReset();
        useSessionExecutionRunsSupportedSpy.mockReset();
        resumeCapabilityOptionsSpy.mockReset();
        canLaunchExecutionRunsForSessionSpy.mockReset();
        preferredServerIdState.value = 'server-canonical';
        sessionMachineTargetState.value = null;
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

    it('builds resume capability options from the resolved session machine target', async () => {
        sessionMachineTargetState.value = { machineId: 'machine-reachable', basePath: '/tmp/reachable' };
        sessionState.value = {
            id: 'session-1',
            active: false,
            serverId: 'server-explicit',
            metadata: {
                flavor: 'claude',
                machineId: 'machine-stale',
                path: '/tmp/stale',
            },
        } as any;

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(resumeCapabilityOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-reachable',
            enabled: true,
        }));
        await hook.unmount();
    });

    it('lets an inactive external session launch only after resume support and a live execution-runs tool agree', async () => {
        sessionState.value = {
            id: 'session-1',
            active: false,
            serverId: 'server-explicit',
            metadata: {
                machineId: 'machine-1',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme-lifecycle',
                    agent: { providerSessionId: 'acme-session-1' },
                },
            },
        } as any;
        resumeCapabilityOptionsSpy.mockReturnValue({
            resumeCapabilityOptions: {
                currentAgentCapabilities: {
                    agentId: 'acme-lifecycle',
                    identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
                    generation: 42,
                    capabilities: {
                        sessions: {
                            open: ['resume'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
        });
        useSessionExecutionRunsSupportedSpy.mockReturnValue(false);

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook((session: typeof sessionState.value) => (
            useSessionExecutionRunLaunchability('session-1', session)
        ), { initialProps: sessionState.value });

        expect(hook.getCurrent().canLaunchExecutionRuns).toBe(false);
        expect(canLaunchExecutionRunsForSessionSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            allowWhileInactive: true,
            executionRunsSupported: false,
        }));

        useSessionExecutionRunsSupportedSpy.mockReturnValue(true);
        await hook.rerender(sessionState.value);

        expect(hook.getCurrent().canLaunchExecutionRuns).toBe(true);
        expect(canLaunchExecutionRunsForSessionSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            allowWhileInactive: true,
            executionRunsSupported: true,
        }));
        await hook.unmount();
    });
});
