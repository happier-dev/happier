import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const resumeSessionMock = vi.hoisted(() => vi.fn());
const readAgentScopedPluginSettingsSnapshotMock = vi.hoisted(() => vi.fn(async () => null));
const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, any>,
    sessionMessages: {} as Record<string, any>,
    machines: {} as Record<string, any>,
    settings: {} as Record<string, unknown>,
    getProjectForSession: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => storageStateMock,
    },
}));

vi.mock('./sessions', () => ({
    resumeSession: (options: unknown) => resumeSessionMock(options),
}));

vi.mock('@/agents/registry/agentScopedPluginSettings', () => ({
    readAgentScopedPluginSettingsSnapshot: readAgentScopedPluginSettingsSnapshotMock,
}));

vi.mock('@/text', () => ({
    t: (key: string) => `t:${key}`,
}));

describe('session goal operations', () => {
    beforeEach(() => {
        vi.resetModules();
        sessionRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        resumeSessionMock.mockReset();
        readAgentScopedPluginSettingsSnapshotMock.mockReset();
        readAgentScopedPluginSettingsSnapshotMock.mockResolvedValue(null);
        storageStateMock.sessions = {
            'session-1': {
                active: true,
                agentState: {
                    capabilities: {
                        sessionGoalSetSupported: true,
                        sessionGoalClearSupported: true,
                    },
                },
            },
        };
        storageStateMock.sessionMessages = {};
        storageStateMock.machines = {};
        storageStateMock.settings = {};
        storageStateMock.getProjectForSession.mockReset();
    });

    it('sets the session goal through the session-scoped RPC lane', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { objective: 'ship work-state' });

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.goal.set',
            payload: { objective: 'ship work-state' },
        });
    });

    it('accepts canonical work-state responses from native goal mutation RPCs', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock
            .mockResolvedValueOnce({ workState: null })
            .mockResolvedValueOnce({ workState: null });
        const { sessionGoalClear, sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { objective: 'ship work-state' })).resolves.toEqual({ ok: true });
        await expect(sessionGoalClear('session-1')).resolves.toEqual({ ok: true });
    });

    it('clears the session goal through the session-scoped RPC lane', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        const { sessionGoalClear } = await import('./sessionGoals');

        const result = await sessionGoalClear('session-1');

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.goal.clear',
            payload: {},
        });
    });

    it('returns a stable unsupported response for malformed RPC replies', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: 'yes' });
        const { sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { status: 'paused' })).resolves.toEqual({
            ok: false,
            error: 't:session.workState.goal.errorUnsupportedResponse',
        });
    });

    it('passes through bare runtime error responses from older session runners', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({
            error: 'unsupported_session_runtime_method:session.goal.set',
            errorCode: 'unsupported_session_runtime_method',
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { objective: 'ship work-state' })).resolves.toEqual({
            ok: false,
            error: 'unsupported_session_runtime_method:session.goal.set',
            errorCode: 'unsupported_session_runtime_method',
        });
    });

   it('passes token budget through the inactive initial goal resume path', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        resumeSessionMock.mockResolvedValue({ type: 'success' });
        storageStateMock.settings = { codexBackendMode: 'appServer' };
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local', daemonSessionGoalControlsSupported: true },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { objective: 'ship budget UI', tokenBudget: 25_000 });

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            initialGoal: {
                objective: 'ship budget UI',
                tokenBudget: 25_000,
            },
        }));
    });

    it('keeps inactive objective edits on the state-control path when resume is disabled', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local', daemonSessionGoalControlsSupported: true },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', {
            objective: 'edit existing goal',
            resumeInactiveWithInitialGoal: false,
        });

        expect(result).toEqual({ ok: true });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: 'daemon.sessionGoal.set',
            payload: {
                sessionId: 'session-1',
                objective: 'edit existing goal',
            },
        });
    });

    it('keeps inactive status-only changes on the daemon state-control path without resuming', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local', daemonSessionGoalControlsSupported: true },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { status: 'paused' });

        expect(result).toEqual({ ok: true });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: 'daemon.sessionGoal.set',
            payload: {
                sessionId: 'session-1',
                status: 'paused',
            },
        });
    });

    it('keeps inactive clear on the daemon state-control path without resuming', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local', daemonSessionGoalControlsSupported: true },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        const { sessionGoalClear } = await import('./sessionGoals');

        const result = await sessionGoalClear('session-1');

        expect(result).toEqual({ ok: true });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: 'daemon.sessionGoal.clear',
            payload: { sessionId: 'session-1' },
        });
    });

    it('returns a stable error when inactive state controls have no reachable machine target', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { status: 'paused' });

        expect(result).toEqual({
            ok: false,
            error: 'session_goal_control_machine_unavailable',
            errorCode: 'session_goal_control_machine_unavailable',
        });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed before resuming when an inactive session targets an older daemon', async () => {
        storageStateMock.sessions = {
            'session-1': {
                active: false,
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                metadata: { host: 'host.local' },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: { machineId: 'machine-1', path: '/repo' },
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { objective: 'must not disappear' })).resolves.toEqual({
            ok: false,
            error: 'session_goal_control_unsupported',
            errorCode: 'session_goal_control_unsupported',
        });
        expect(resumeSessionMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed before calling an active runner that did not advertise goal controls', async () => {
        storageStateMock.sessions = {
            'session-1': {
                active: true,
                agentState: { capabilities: {} },
                metadata: { machineId: 'machine-1' },
            },
        };
        const { sessionGoalClear, sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { objective: 'unsupported' })).resolves.toEqual({
            ok: false,
            error: 'session_goal_control_unsupported',
            errorCode: 'session_goal_control_unsupported',
        });
        await expect(sessionGoalClear('session-1')).resolves.toEqual({
            ok: false,
            error: 'session_goal_control_unsupported',
            errorCode: 'session_goal_control_unsupported',
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('keeps active status-only changes on the live session-scoped RPC path', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        storageStateMock.sessions = {
            'session-1': {
                active: true,
                agentState: {
                    capabilities: {
                        sessionGoalSetSupported: true,
                        sessionGoalClearSupported: true,
                    },
                },
                metadata: {
                    flavor: 'codex',
                    path: '/repo',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1',
                    codexBackendMode: 'appServer',
                },
            },
        };
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { status: 'paused' });

        expect(result).toEqual({ ok: true });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.goal.set',
            payload: { status: 'paused' },
        });
    });
});

describe('session goal operations (real scoped transport)', () => {
    let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;
    let realStorage: typeof import('@/sync/domains/state/storage').storage;
    let fixtures: typeof import('@/dev/testkit/fixtures/sessionFixtures');
    let machineFixtures: typeof import('@/dev/testkit/fixtures/machineFixtures');
    let metadata: typeof import('@happier-dev/session-core/state');

    beforeAll(async () => {
        vi.doUnmock('@/sync/domains/state/storage');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId');
        vi.doUnmock('./sessions');
        vi.doUnmock('@/agents/registry/agentScopedPluginSettings');
        vi.doUnmock('@/text');
        vi.resetModules();
        const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
        boundary = await installSessionOpsNetworkBoundary();
        realStorage = (await import('@/sync/domains/state/storage')).storage;
        fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
        machineFixtures = await import('@/dev/testkit/fixtures/machineFixtures');
        metadata = await import('@happier-dev/session-core/state');
    });

    beforeEach(() => {
        realStorage.setState(realStorage.getInitialState(), true);
        boundary.resetRequests();
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS', '');
        // Observe the ACK budget without elapsed wall time; network promises and timers stay real.
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        for (const sessionId of Object.keys(realStorage.getState().sessions)) {
            realStorage.getState().clearSessionResuming(sessionId);
        }
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    afterAll(() => boundary?.dispose());

    it('resumes an inactive session with an initial goal instead of calling unavailable session RPC', async () => {
        const ownedHome = await boundary.addHome('https://goal-owner.example.test', 'goal-owner');
        const requestedHome = await boundary.addHome('https://goal-requested.example.test', 'goal-requested');
        const runtimeDescriptorV1 = { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } as const;
        realStorage.setState({
            sessions: {
                'session-1': fixtures.createSessionFixture({
                    id: 'session-1',
                    serverId: ownedHome.id,
                    active: false,
                    metadata: metadata.MetadataSchema.parse({
                        flavor: 'codex', path: '/repo', host: 'host.local', machineId: 'machine-1',
                        codexSessionId: 'thread-1', codexBackendMode: 'appServer', runtimeDescriptorV1,
                    }),
                }),
            },
            machines: {
                'machine-1': machineFixtures.createMachineFixture({
                    metadata: { ...machineFixtures.createMachineFixture().metadata!,
                        host: 'host.local', daemonSessionGoalControlsSupported: true },
                }),
            },
            machineListByServerId: {
                [ownedHome.id]: [machineFixtures.createMachineFixture()],
                [requestedHome.id]: [machineFixtures.createMachineFixture()],
            },
        });
        const { createSessionMessagesFixture, createToolCallMessageFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
        realStorage.setState({
            sessionMessages: {
                'session-1': createSessionMessagesFixture({
                    messageIdsOldestFirst: ['older', 'latest'],
                    messagesById: {
                        older: createToolCallMessageFixture({ id: 'older', seq: 17 }),
                        latest: createToolCallMessageFixture({ id: 'latest', seq: 42 }),
                    },
                }),
            },
        });
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        const { sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { objective: 'line one\nline two' }, {
            serverId: requestedHome.id,
        })).resolves.toEqual({ ok: true });

        expect(boundary.requests.filter((request) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION))
            .toEqual([expect.objectContaining({
            serverUrl: requestedHome.serverUrl,
            token: requestedHome.token,
            targetId: 'machine-1',
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: expect.objectContaining({
                type: 'resume-session', sessionId: 'session-1', directory: '/repo',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                resume: 'thread-1', runtimeDescriptorV1, initialTranscriptAfterSeq: 42,
                initialGoal: { objective: 'line one\nline two' },
            }),
        })]);
        expect(boundary.requests.filter((request) => request.method === 'session.goal.set')).toEqual([]);
    });
});
