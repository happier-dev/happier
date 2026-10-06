import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { act } from 'react-test-renderer';

import { installServerHookCommonModuleMocks } from '../server/serverHookModuleTestHelpers';

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
const featureScopeSpy = vi.hoisted(() => vi.fn());
const machineReachabilitySpy = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ machineReachable: true })));
const externalSessionRuntimeSpy = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({
    externalSessionLink: null,
    status: { runnerActive: true },
})));
const sessionMachineTargetState = vi.hoisted(() => ({
    value: null as null | { machineId: string; basePath: string },
}));

const sessionState = vi.hoisted(() => ({
    value: null as Session | null,
}));

installServerHookCommonModuleMocks({
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useSession: () => sessionState.value,
        useProjectForSession: () => null,
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (_featureId: string, scope?: unknown) => {
        featureScopeSpy(scope);
        return true;
    },
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: (...args: unknown[]) => machineReachabilitySpy(...args),
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

vi.mock('@/components/sessions/model/useSessionExternalSessionRuntime', () => ({
    useSessionExternalSessionRuntime: (...args: unknown[]) => externalSessionRuntimeSpy(...args),
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
    const initialStorageState: { sessions: Record<string, Session> } = { sessions: {} };
    beforeEach(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        initialStorageState.sessions = storage.getState().sessions;
        storage.setState({ sessions: {} });
        sessionState.value = createSessionFixture({ id: 'session-1', active: true, serverId: 'server-explicit', metadata: { flavor: 'claude' } });
    });
    afterEach(async () => {
        await standardCleanup();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ sessions: initialStorageState.sessions });
        useExecutionRunsBackendsForSessionSpy.mockReset();
        useSessionExecutionRunsSupportedSpy.mockReset();
        resumeCapabilityOptionsSpy.mockReset();
        canLaunchExecutionRunsForSessionSpy.mockReset();
        featureScopeSpy.mockClear();
        machineReachabilitySpy.mockClear();
        externalSessionRuntimeSpy.mockClear();
        sessionMachineTargetState.value = null;
        sessionState.value = null;
    });

    it('says why agents cannot start here instead of only hiding the launcher', async () => {
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');

        const live = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));
        expect(live.getCurrent().launchUnavailableReason).toBeNull();
        await live.unmount();

        // An inactive Session whose Machine is unreachable cannot resume, so it cannot start agents.
        machineReachabilitySpy.mockImplementation(() => ({ machineReachable: false }));
        sessionState.value = createSessionFixture({ id: 'session-1', active: false, serverId: 'server-explicit', metadata: { flavor: 'claude' } });
        const offline = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));
        expect(offline.getCurrent()).toMatchObject({ canShowExecutionRunLauncher: false, launchUnavailableReason: 'machineOffline' });
        await offline.unmount();

        // Reachable but not resumable: the Session itself is what stops it.
        machineReachabilitySpy.mockImplementation(() => ({ machineReachable: true }));
        const stopped = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));
        expect(stopped.getCurrent()).toMatchObject({ canShowExecutionRunLauncher: false, launchUnavailableReason: 'sessionInactive' });
        await stopped.unmount();

        // A Session started outside Happier can start agents only while Happier's runner is attached.
        sessionState.value = createSessionFixture({ id: 'session-1', active: true, serverId: 'server-explicit', metadata: { flavor: 'claude' } });
        externalSessionRuntimeSpy.mockImplementation(() => ({
            externalSessionLink: { v: 1 } as any,
            status: { runnerActive: false },
        }));
        const external = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));
        expect(external.getCurrent()).toMatchObject({ canShowExecutionRunLauncher: false, launchUnavailableReason: 'externalRunnerInactive' });
        await external.unmount();
        externalSessionRuntimeSpy.mockImplementation(() => ({ externalSessionLink: null, status: { runnerActive: true } }));
    });

    it('exposes the canonical session server id for consumers and backend lookup', async () => {
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(hook.getCurrent()).toMatchObject({
            sessionServerId: 'server-explicit',
            executionRunsSupported: true,
            executionRunsBackends: { claude: { available: true, intents: ['review'] } },
        });

        await hook.unmount();
    });

    it('refreshes backend lookup when the preferred session server changes', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        sessionState.value = createSessionFixture({ id: 'session-1', active: true, serverId: undefined, metadata: { flavor: 'claude' } });
        storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'server-canonical' }) } });
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook((session: typeof sessionState.value) => useSessionExecutionRunLaunchability('session-1', session), {
            initialProps: sessionState.value,
        });

        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenLastCalledWith('session-1', 'server-canonical');

        await act(async () => {
            storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'server-updated' }) } });
        });
        await hook.rerender(sessionState.value);

        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenLastCalledWith('session-1', 'server-updated');

        await hook.unmount();
    });

    it('uses the direct qualified session Home even when the legacy lookup has no Session', async () => {
        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('session-1', 'server-explicit');
        expect(hook.getCurrent().sessionServerId).toBe('server-explicit');

        await hook.unmount();
    });

    it('uses the explicit Home for feature, Machine, runtime and backend decisions even when the same-id Session points at another Home', async () => {
        sessionState.value = createSessionFixture({
            id: 'same-session',
            active: true,
            serverId: 'home-a',
            metadata: { flavor: 'claude', machineId: 'machine-a' },
        });
        sessionMachineTargetState.value = { machineId: 'machine-b', basePath: '/home-b/workspace' };

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('same-session', sessionState.value, 'home-b'));

        expect(featureScopeSpy).toHaveBeenCalledWith({ scopeKind: 'spawn', serverId: 'home-b' });
        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('same-session', 'home-b');
        expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('same-session', 'home-b');
        expect(machineReachabilitySpy).toHaveBeenCalledWith('same-session', 'home-b');
        expect(externalSessionRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'same-session',
            serverId: 'home-b',
        }));
        expect(resumeCapabilityOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-b',
            serverId: 'home-b',
        }));
        expect(hook.getCurrent().sessionServerId).toBe('home-b');
        await hook.unmount();
    });

    it('builds resume capability options from the resolved session machine target', async () => {
        sessionMachineTargetState.value = { machineId: 'machine-reachable', basePath: '/tmp/reachable' };
        sessionState.value = createSessionFixture({
            id: 'session-1',
            active: false,
            serverId: 'server-explicit',
            metadata: {
                flavor: 'claude',
                machineId: 'machine-stale',
                path: '/tmp/stale',
            },
        });

        const { useSessionExecutionRunLaunchability } = await import('./useSessionExecutionRunLaunchability');
        const hook = await renderHook(() => useSessionExecutionRunLaunchability('session-1', sessionState.value));

        expect(resumeCapabilityOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-reachable',
            enabled: true,
        }));
        await hook.unmount();
    });

    it('lets an inactive external session launch only after resume support and a live execution-runs tool agree', async () => {
        sessionState.value = createSessionFixture({
            id: 'session-1',
            active: false,
            serverId: 'server-explicit',
            metadataLayoutVersion: 1,
            metadata: {},
            ownerMetadataView: {
                path: '/tmp/project',
                host: 'devbox',
                machineId: 'machine-1',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme-lifecycle',
                    agent: { providerSessionId: 'acme-session-1' },
                },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'acme-session-1' },
            },
        });
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
