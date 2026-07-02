import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const resumeSessionMock = vi.hoisted(() => vi.fn());
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
        storageStateMock.sessions = {};
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

    it('resumes an inactive session with an initial goal instead of calling unavailable session RPC', async () => {
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
        storageStateMock.sessionMessages = {
            'session-1': {
                messageIdsOldestFirst: ['older', 'latest'],
                messagesById: {
                    older: { id: 'older', seq: 17 },
                    latest: { id: 'latest', seq: 42 },
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local' },
            },
        };
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { objective: 'line one\nline two' }, { serverId: 'server-explicit' });

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/repo',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'thread-1',
            serverId: 'server-explicit',
            codexBackendMode: 'appServer',
            initialTranscriptAfterSeq: 42,
            initialGoal: {
                objective: 'line one\nline two',
            },
        }));
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
                metadata: { host: 'host.local' },
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
                metadata: { host: 'host.local' },
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
                metadata: { host: 'host.local' },
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
                metadata: { host: 'host.local' },
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

    it('keeps active status-only changes on the live session-scoped RPC path', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        storageStateMock.sessions = {
            'session-1': {
                active: true,
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
