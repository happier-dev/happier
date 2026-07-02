import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const machineRpcMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: machineRpcMock,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: getStateMock,
        },
    });
});

type SessionFixture = ReturnType<typeof createSessionFixture>;
type MachineFixture = ReturnType<typeof createMachineFixture>;
type SessionProjectResolver = (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;

const baseSessionMetadata = {
    path: '/Users/tester/project',
    host: 'tester.local',
    homeDir: '/Users/tester',
    machineId: 'machine-1',
};

function createSessionScmState(params: Readonly<{
    preferredBackend?: 'git' | 'sapling';
    session?: SessionFixture | null;
    machines?: MachineFixture[];
    getProjectForSession?: SessionProjectResolver;
}> = {}) {
    const session = params.session ?? null;
    const machines = params.machines ?? [];
    return {
        settings: {
            scmGitRepoPreferredBackend: params.preferredBackend ?? 'git',
        },
        sessions: session ? { [session.id]: session } : {},
        machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
        getProjectForSession: params.getProjectForSession ?? (() => null),
    };
}

describe('sessionScm', () => {
    afterEach(() => {
        sessionRpcMock.mockReset();
        machineRpcMock.mockReset();
        getStateMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
    });

    it('returns unsupported fallback when status snapshot rpc payload is null', async () => {
        getStateMock.mockReturnValue(createSessionScmState());
        sessionRpcMock.mockResolvedValue(null);

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('prefers machine RPC when a session has an attached machine', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '~/repo',
            },
            {
                timeoutMs: expect.any(Number),
            },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('prefers machine RPC for linked direct sessions without top-level machine metadata', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: false,
                metadata: {
                    ...baseSessionMetadata,
                    path: '/workspace/direct-repo',
                    machineId: '',
                    directSessionV1: {
                        v: 1,
                        providerId: 'codex',
                        machineId: 'machine-direct',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'codexHome', home: 'user' },
                    },
                },
            }),
            machines: [createMachineFixture({ id: 'machine-direct' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-direct',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '/workspace/direct-repo',
            },
            {
                timeoutMs: expect.any(Number),
            },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('uses the active session worktree path for machine RPC even when the project points at the main repo', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '/workspace/repo/.dev/worktree/gentle-meadow',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-1',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '/workspace/repo/.dev/worktree/gentle-meadow',
            },
            {
                timeoutMs: expect.any(Number),
            },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('applies sapling backend preference when configured (machine RPC)', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            preferredBackend: 'sapling',
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        await sessionScmStatusSnapshot('session-1', {});

        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '~/repo',
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
            {
                timeoutMs: expect.any(Number),
            },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('falls back to session RPC when machine RPC reports method not found', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('does not fall back to session RPC for inactive sessions when machine RPC reports method not found', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: false,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('fails closed for inactive sessions even when project resolver returns a machine target', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: false,
                metadata: {
                    ...baseSessionMetadata,
                    path: '',
                    machineId: '',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-1',
                            path: '~/repo',
                        },
                    }
                    : null,
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(machineRpcMock).not.toHaveBeenCalled();
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('fails closed for inactive sessions when machine target is unavailable', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: false,
                metadata: {
                    ...baseSessionMetadata,
                    path: '',
                    machineId: '',
                },
            }),
            machines: [],
            getProjectForSession: () => null,
        }));
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(machineRpcMock).not.toHaveBeenCalled();
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes remote management and branch integration through the preferred machine SCM path', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            stdout: '',
            stderr: '',
        });

        const sessionScm = await import('./sessionScm') as Record<string, unknown>;
        expect(typeof sessionScm.sessionScmRemoteAdd).toBe('function');
        expect(typeof sessionScm.sessionScmRemoteSetUrl).toBe('function');
        expect(typeof sessionScm.sessionScmRemoteRemove).toBe('function');
        expect(typeof sessionScm.sessionScmBranchMerge).toBe('function');
        expect(typeof sessionScm.sessionScmBranchRebase).toBe('function');
        expect(typeof sessionScm.sessionScmBranchOperationContinue).toBe('function');
        expect(typeof sessionScm.sessionScmBranchOperationAbort).toBe('function');

        await (sessionScm.sessionScmRemoteAdd as Function)('session-1', {
            name: 'origin',
            fetchUrl: 'git@example.com:repo.git',
        });
        await (sessionScm.sessionScmRemoteSetUrl as Function)('session-1', {
            name: 'origin',
            fetchUrl: 'git@example.com:next.git',
            pushUrl: null,
        });
        await (sessionScm.sessionScmRemoteRemove as Function)('session-1', {
            name: 'origin',
        });
        await (sessionScm.sessionScmBranchMerge as Function)('session-1', {
            sourceRef: 'origin/main',
        });
        await (sessionScm.sessionScmBranchRebase as Function)('session-1', {
            sourceRef: 'origin/main',
        });
        await (sessionScm.sessionScmBranchOperationContinue as Function)('session-1', {
            operation: 'merge',
        });
        await (sessionScm.sessionScmBranchOperationAbort as Function)('session-1', {
            operation: 'rebase',
        });

        expect(machineRpcMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '~/repo',
                name: 'origin',
                fetchUrl: 'git@example.com:repo.git',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            RPC_METHODS.SCM_REMOTE_SET_URL,
            {
                cwd: '~/repo',
                name: 'origin',
                fetchUrl: 'git@example.com:next.git',
                pushUrl: null,
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            3,
            'machine-1',
            RPC_METHODS.SCM_REMOTE_REMOVE,
            {
                cwd: '~/repo',
                name: 'origin',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            4,
            'machine-1',
            RPC_METHODS.SCM_BRANCH_MERGE,
            {
                cwd: '~/repo',
                sourceRef: 'origin/main',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            5,
            'machine-1',
            RPC_METHODS.SCM_BRANCH_REBASE,
            {
                cwd: '~/repo',
                sourceRef: 'origin/main',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            6,
            'machine-1',
            RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
            {
                cwd: '~/repo',
                operation: 'merge',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            7,
            'machine-1',
            RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
            {
                cwd: '~/repo',
                operation: 'rebase',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes repository provisioning operations through machine RPC with the session cwd', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            targets: [],
            repository: {
                nameWithOwner: 'happier-dev/repo',
                url: 'https://github.com/happier-dev/repo',
                visibility: 'private',
            },
            remote: {
                name: 'origin',
                fetchUrl: 'https://github.com/happier-dev/repo.git',
            },
            pushed: false,
        });

        const sessionScm = await import('./sessionScm') as Record<string, unknown>;
        expect(typeof sessionScm.sessionScmRepositoryInit).toBe('function');
        expect(typeof sessionScm.sessionScmHostingRepositoryDescribePublishTargets).toBe('function');
        expect(typeof sessionScm.sessionScmHostingRepositoryPublish).toBe('function');

        await (sessionScm.sessionScmRepositoryInit as Function)('session-1', {
            initialBranch: 'main',
        });
        await (sessionScm.sessionScmHostingRepositoryDescribePublishTargets as Function)('session-1', {
            providerKind: 'github',
        });
        await (sessionScm.sessionScmHostingRepositoryPublish as Function)('session-1', {
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
            repositoryName: 'repo',
            visibility: 'private',
            remoteName: 'origin',
            remoteUrlKind: 'https',
            remoteConflictStrategy: 'fail',
            pushCurrentBranch: true,
        });

        expect(machineRpcMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            RPC_METHODS.SCM_REPOSITORY_INIT,
            {
                cwd: '~/repo',
                initialBranch: 'main',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
            {
                cwd: '~/repo',
                providerKind: 'github',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            3,
            'machine-1',
            RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
            {
                cwd: '~/repo',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'repo',
                visibility: 'private',
                remoteName: 'origin',
                remoteUrlKind: 'https',
                remoteConflictStrategy: 'fail',
                pushCurrentBranch: true,
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes pull request operations through machine RPC with the session cwd', async () => {
        getStateMock.mockReturnValue(createSessionScmState({
            session: createSessionFixture({
                id: 'session-1',
                active: true,
                metadata: {
                    ...baseSessionMetadata,
                    path: '~/repo',
                    homeDir: '/Users/tester',
                    machineId: 'machine-1',
                },
            }),
            machines: [createMachineFixture({ id: 'machine-1' })],
        }));
        machineRpcMock.mockResolvedValue({
            success: true,
            pullRequests: [],
            pullRequest: null,
            url: 'https://github.com/happier/dev/compare/main...feature/prs',
            kind: 'no-auth',
            composeUrl: 'https://github.com/happier/dev/compare/main...feature/prs',
        });

        const sessionScm = await import('./sessionScm') as Record<string, unknown>;
        expect(typeof sessionScm.sessionScmRepositoryRemoveIndexLock).toBe('function');
        expect(typeof sessionScm.sessionScmPullRequestList).toBe('function');
        expect(typeof sessionScm.sessionScmPullRequestGet).toBe('function');
        expect(typeof sessionScm.sessionScmPullRequestOpenCompose).toBe('function');
        expect(typeof sessionScm.sessionScmPullRequestOpenOrReuse).toBe('function');

        await (sessionScm.sessionScmPullRequestList as Function)('session-1', {
            head: 'feature/prs',
        });
        await (sessionScm.sessionScmPullRequestGet as Function)('session-1', {
            prReference: { number: 42 },
        });
        await (sessionScm.sessionScmPullRequestOpenCompose as Function)('session-1', {
            base: 'main',
            head: 'feature/prs',
        });
        await (sessionScm.sessionScmPullRequestOpenOrReuse as Function)('session-1', {
            base: 'main',
            head: 'feature/prs',
            title: 'Feature PR',
            body: '',
        });
        await (sessionScm.sessionScmRepositoryRemoveIndexLock as Function)('session-1', {});

        expect(machineRpcMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_LIST,
            {
                cwd: '~/repo',
                head: 'feature/prs',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_GET,
            {
                cwd: '~/repo',
                prReference: { number: 42 },
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            3,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
            {
                cwd: '~/repo',
                base: 'main',
                head: 'feature/prs',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            5,
            'machine-1',
            RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            {
                cwd: '~/repo',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            4,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
            {
                cwd: '~/repo',
                base: 'main',
                head: 'feature/prs',
                title: 'Feature PR',
                body: '',
            },
            { timeoutMs: expect.any(Number) },
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });
});
