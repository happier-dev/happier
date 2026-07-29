import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const workspaceSnapshotState = {
    value: null as any,
};

const workspaceErrorState = {
    value: null as any,
};

const updateWorkspaceScmSnapshotSpy = vi.fn();
const updateWorkspaceScmSnapshotErrorSpy = vi.fn();
const updateWorkspaceScmStatusSpy = vi.fn();
const pruneWorkspaceScmTouchedPathsSpy = vi.fn();
const pruneWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const pruneWorkspaceScmCommitSelectionPatchesSpy = vi.fn();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({
        updateWorkspaceScmSnapshot: (scope: any, snapshot: any) => updateWorkspaceScmSnapshotSpy(scope, snapshot),
        updateWorkspaceScmSnapshotError: (scope: any, error: any) => updateWorkspaceScmSnapshotErrorSpy(scope, error),
        updateWorkspaceScmStatus: (scope: any, status: any) => updateWorkspaceScmStatusSpy(scope, status),
        pruneWorkspaceScmTouchedPaths: (scope: any, activePaths: any) => pruneWorkspaceScmTouchedPathsSpy(scope, activePaths),
        pruneWorkspaceScmCommitSelectionPaths: (scope: any, activePaths: any) => pruneWorkspaceScmCommitSelectionPathsSpy(scope, activePaths),
        pruneWorkspaceScmCommitSelectionPatches: (scope: any, activePaths: any) => pruneWorkspaceScmCommitSelectionPatchesSpy(scope, activePaths),
    } as any);

    return createStorageModuleStub({
        storage: store as any,
        useWorkspaceScmSnapshot: () => workspaceSnapshotState.value,
        useWorkspaceScmSnapshotError: () => workspaceErrorState.value,
    });
});

const fetchSnapshotForMachinePathSpy = vi.fn<(input: { machineId: string; path: string; serverId?: string }) => Promise<any>>(async () => ({
    fetchedAt: Date.now(),
    projectKey: 'm1:/repo',
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: null },
    capabilities: {},
    branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [{ path: 'src/a.ts', kind: 'modified', previousPath: null, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false }, includeStatus: null, pendingStatus: 'pending', hasIncludedDelta: false, hasPendingDelta: true }],
    totals: {
        includedFiles: 0,
        pendingFiles: 1,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 0,
    },
} as any));

vi.mock('@/scm/scmRepositoryService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/scm/scmRepositoryService')>();
    return {
        ...actual,
        scmRepositoryService: {
            fetchSnapshotForMachinePath: (input: any) => fetchSnapshotForMachinePathSpy(input),
        } as any,
    };
});

describe('useWorkspaceScmSnapshotController', () => {
    it('refreshes and writes snapshot into workspace-scoped store state', async () => {
        updateWorkspaceScmSnapshotSpy.mockClear();
        updateWorkspaceScmSnapshotErrorSpy.mockClear();
        updateWorkspaceScmStatusSpy.mockClear();
        pruneWorkspaceScmTouchedPathsSpy.mockClear();
        pruneWorkspaceScmCommitSelectionPathsSpy.mockClear();
        pruneWorkspaceScmCommitSelectionPatchesSpy.mockClear();
        fetchSnapshotForMachinePathSpy.mockClear();

        const { useWorkspaceScmSnapshotController } = await import('./useWorkspaceScmSnapshotController');
        await renderHook(() => useWorkspaceScmSnapshotController({
            serverId: 'srv1',
            machineId: 'm1',
            rootPath: '/repo',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(fetchSnapshotForMachinePathSpy).toHaveBeenCalledWith({ serverId: 'srv1', machineId: 'm1', path: '/repo' });
        expect(updateWorkspaceScmSnapshotSpy).toHaveBeenCalledTimes(1);
        expect(updateWorkspaceScmSnapshotSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            serverId: 'srv1',
            machineId: 'm1',
            rootPath: '/repo',
        }));
        expect(updateWorkspaceScmSnapshotErrorSpy).toHaveBeenCalledWith(expect.anything(), null);
        expect(updateWorkspaceScmStatusSpy).toHaveBeenCalledTimes(1);
        expect(pruneWorkspaceScmTouchedPathsSpy).toHaveBeenCalledTimes(1);
        expect(pruneWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalledTimes(1);
        expect(pruneWorkspaceScmCommitSelectionPatchesSpy).toHaveBeenCalledTimes(1);
    });
});
