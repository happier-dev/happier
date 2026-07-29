import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmCommitCreate } from '@/sync/ops/scm/machineScm';

const machineScmCommitCreateSpy = vi.hoisted(() => vi.fn<typeof machineScmCommitCreate>(async () => ({
    success: true,
    commitSha: 'commit-1',
})));
const clearWorkspaceScmCommitSelectionPathsSpy = vi.hoisted(() => vi.fn());
const clearWorkspaceScmCommitSelectionPatchesSpy = vi.hoisted(() => vi.fn());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({}).module;
});

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmCommitCreate: (...args: Parameters<typeof machineScmCommitCreateSpy>) => machineScmCommitCreateSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: createStorageStoreMock({
            beginWorkspaceScmOperation: () => ({
                started: true,
                operation: { id: 'op-1', startedAt: 1, sessionId: 'session-1', operation: 'commit' },
            }),
            finishWorkspaceScmOperation: () => true,
            appendWorkspaceScmOperation: () => {},
            clearWorkspaceScmCommitSelectionPaths: (...args: unknown[]) => clearWorkspaceScmCommitSelectionPathsSpy(...args),
            clearWorkspaceScmCommitSelectionPatches: (...args: unknown[]) => clearWorkspaceScmCommitSelectionPatchesSpy(...args),
        } as any),
    });
});

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'server-1:machine-1:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            writeCommit: true,
        } as any,
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 1,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
    };
}

describe('executeWorkspaceScmCommit', () => {
    beforeEach(() => {
        machineScmCommitCreateSpy.mockClear();
        clearWorkspaceScmCommitSelectionPathsSpy.mockClear();
        clearWorkspaceScmCommitSelectionPatchesSpy.mockClear();
    });

    it('passes the workspace server scope to commit creation RPCs', async () => {
        const { executeWorkspaceScmCommit } = await import('./executeWorkspaceScmCommit');

        await executeWorkspaceScmCommit({
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            commitMessage: 'Commit message',
            scmCommitStrategy: 'atomic',
            commitSelectionPaths: [],
            commitSelectionPatches: [],
            refreshScmData: async () => {},
            setScmOperationBusy: () => {},
            setScmOperationStatus: () => {},
            tracking: null,
        });

        expect(machineScmCommitCreateSpy).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                cwd: '/repo',
                message: 'Commit message',
                scope: { kind: 'all-pending' },
            }),
            { serverId: 'server-1' },
        );
        expect(clearWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalledTimes(1);
        expect(clearWorkspaceScmCommitSelectionPatchesSpy).toHaveBeenCalledTimes(1);
    });
});
