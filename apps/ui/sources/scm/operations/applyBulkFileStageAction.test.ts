import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWritableScmSnapshot, installScmOperationsCommonModuleMocks } from './scmOperationsTestHelpers';

const sessionScmChangeInclude = vi.hoisted(() => vi.fn());
const sessionScmChangeExclude = vi.hoisted(() => vi.fn());
const sessionScmRepositoryRemoveIndexLock = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// The SCM write facade and the Machine RPC transport (the post-write status read) are the system boundaries;
// the operation lock, preflight policy, repository refresh and operation log run for real.
vi.mock('@/sync/ops', () => ({
    sessionScmChangeInclude,
    sessionScmChangeExclude,
    sessionScmRepositoryRemoveIndexLock,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

installScmOperationsCommonModuleMocks();

/** A writable `/repo` Session whose status read answers with a refreshed head, so a completed write is observable. */
function seedWritableSession() {
    const machine = createMachineFixture({ id: 'machine-1' });
    const base = createSessionFixture();
    storage.setState({
        machines: { [machine.id]: machine },
        sessions: { s1: createSessionFixture({ id: 's1', metadata: { ...base.metadata!, machineId: machine.id, path: '/repo' } }) },
    });
    machineRpc.mockImplementation(async (params: { method: string }) => params.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
        ? { success: true, snapshot: createWritableScmSnapshot({ branch: { head: 'refreshed', upstream: 'origin/refreshed', ahead: 0, behind: 0, detached: false } }) }
        : { success: false, errorCode: 'BACKEND_UNAVAILABLE', error: `unexpected ${params.method}` });
}

describe('applyBulkFileStageAction', () => {
    const initialStorageState = storage.getState();

    function createSession(sessionId: string, workspacePath: string) {
        const now = Date.now();
        return {
            id: sessionId,
            seq: 1,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadata: {
                machineId: 'machine-1',
                path: workspacePath,
                host: 'localhost',
                version: '1.0.0',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            optimisticThinkingAt: null,
        };
    }

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        projectManager.clear();
        sessionScmChangeInclude.mockReset();
        sessionScmChangeExclude.mockReset();
        sessionScmRepositoryRemoveIndexLock.mockReset();
        machineRpc.mockReset();
    });
    afterEach(async () => {
        (await import('@/scm/scmStatusSync')).scmStatusSync.stop('s1');
    });

    it('marks atomic commit selection paths without invoking SCM RPC operations', async () => {
        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');

        const state = storage.getState();
        type StoredSession = Parameters<typeof state.applySessions>[0][number];
        state.applySessions([createSession('s1', '/tmp') as unknown as StoredSession]);

        await applyBulkFileStageAction({
            sessionId: 's1',
            sessionPath: '/tmp',
            snapshot: null,
            scmWriteEnabled: true,
            commitStrategy: 'atomic',
            stage: true,
            paths: ['file', 'file ', ' ', '', 'file '],
            surface: 'files',
        });

        expect(new Set(storage.getState().getSessionProjectScmCommitSelectionPaths('s1'))).toEqual(new Set(['file', 'file ', ' ']));
        expect(sessionScmChangeInclude).not.toHaveBeenCalled();
        expect(sessionScmChangeExclude).not.toHaveBeenCalled();
    });

    it('keeps atomic selection on the requested Home when Session IDs collide', async () => {
        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');
        type StoredSession = Parameters<ReturnType<typeof storage.getState>['applySessions']>[0][number];
        const a = { ...createSession('same', '/repo'), serverId: 'a' } as unknown as StoredSession;
        const b = { ...createSession('same', '/repo'), serverId: 'b' } as unknown as StoredSession;
        storage.setState({
            sessions: { same: a },
            sessionListRowsByServerId: { a: { same: a }, b: { same: b } },
            machineListByServerId: {
                a: [createMachineFixture({ id: 'machine-1' })],
                b: [createMachineFixture({ id: 'machine-1' })],
            },
        });
        await applyBulkFileStageAction({
            sessionId: 'same', serverId: 'b', sessionPath: '/repo', snapshot: null,
            scmWriteEnabled: true, commitStrategy: 'atomic', stage: true,
            paths: ['b.txt'], surface: 'files',
        });
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('same', 'b')).toEqual(['b.txt']);
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('same', 'a')).toEqual([]);
    });

    it('stages deduplicated paths with one include RPC, then records it and refreshes the repository', async () => {
        seedWritableSession();
        sessionScmChangeInclude.mockResolvedValueOnce({ success: true });

        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');

        await applyBulkFileStageAction({
            sessionId: 's1',
            sessionPath: '/repo',
            snapshot: createWritableScmSnapshot(),
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            stage: true,
            paths: ['a.txt', 'a.txt', 'b.txt'],
            surface: 'files',
        });

        expect(sessionScmChangeInclude.mock.calls).toEqual([['s1', { paths: ['a.txt', 'b.txt'] }]]);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]).toMatchObject({ operation: 'stage', status: 'success' });
        expect(storage.getState().getSessionProjectScmSnapshot('s1')?.branch.head).toBe('refreshed');
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });

    it('confirms stale index-lock recovery and retries a bulk stage operation once', async () => {
        seedWritableSession();
        const modalConfirm = vi.mocked(Modal.confirm);
        modalConfirm.mockResolvedValueOnce(true);
        sessionScmChangeInclude
            .mockResolvedValueOnce({
                success: false,
                errorCode: 'COMMAND_FAILED',
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true });
        sessionScmRepositoryRemoveIndexLock.mockResolvedValueOnce({
            success: true,
            removed: true,
            lockPath: '/repo/.git/index.lock',
        });

        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');

        await applyBulkFileStageAction({
            sessionId: 's1',
            sessionPath: '/repo',
            snapshot: createWritableScmSnapshot(),
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            stage: true,
            paths: ['a.txt', 'b.txt'],
            surface: 'files',
        });

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(sessionScmRepositoryRemoveIndexLock).toHaveBeenCalledWith('s1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: expect.any(String),
        });
        expect(sessionScmChangeInclude).toHaveBeenCalledTimes(2);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]).toMatchObject({ operation: 'stage', status: 'success' });
        expect(storage.getState().getSessionProjectScmSnapshot('s1')?.branch.head).toBe('refreshed');
    });
});
