import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({
    v: 1,
    skills: [],
})));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const state = {
        sessions: {
            session_1: {
                id: 'session_1',
                active: false,
                metadata: {
                    path: '/home/coder/project',
                    machineId: 'machine_1',
                },
            },
        },
        applySessions: vi.fn(),
    };
    return createStorageModuleStub({
        storage: { getState: () => state },
    });
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: () => ({
        machineId: 'machine_1',
        basePath: '/Users/alice/project',
        agentBasePath: '/home/coder/project',
        confidence: 'reachable',
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server_1',
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: vi.fn(),
}));

describe('ensureSessionSuggestionCatalogs', () => {
    beforeEach(() => {
        machineRpcMock.mockClear();
    });

    it('uses the machine workspace path for inactive-session catalogs', async () => {
        const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');

        await ensureSessionSuggestionCatalogs('session_1', { skills: true });

        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                sessionId: 'session_1',
                cwd: '/Users/alice/project',
            },
        }));
    });
});
