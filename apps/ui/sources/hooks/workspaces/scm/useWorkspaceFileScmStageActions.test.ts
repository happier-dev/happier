import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    markPaths: vi.fn(),
    unmarkPaths: vi.fn(),
    removePatch: vi.fn(),
    upsertPatch: vi.fn(),
    appendOp: vi.fn(),
    beginWorkspaceScmOperation: vi.fn((_scope: unknown, _operation: unknown) => ({
        started: true as const,
        operation: { id: 'workspace-op-1', startedAt: 1, sessionId: 'workspace', operation: 'stage' as const },
    })),
    finishWorkspaceScmOperation: vi.fn((_scope: unknown, _operationId: unknown) => true),
    updateWorkspaceScmSnapshot: vi.fn(),
    updateWorkspaceScmSnapshotError: vi.fn(),
    updateWorkspaceScmStatus: vi.fn(),
    pruneWorkspaceScmTouchedPaths: vi.fn(),
    pruneWorkspaceScmCommitSelectionPaths: vi.fn(),
    pruneWorkspaceScmCommitSelectionPatches: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
    isAtomic: true,
}));
const machineScmChangeIncludeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true })));
const machineScmChangeExcludeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true })));
const fetchSnapshotForMachinePathMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({
        markWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.markPaths(scope, paths),
        unmarkWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.unmarkPaths(scope, paths),
        removeWorkspaceScmCommitSelectionPatch: (scope: any, path: any) => state.removePatch(scope, path),
        upsertWorkspaceScmCommitSelectionPatch: (scope: any, patch: any) => state.upsertPatch(scope, patch),
        appendWorkspaceScmOperation: (scope: any, entry: any) => state.appendOp(scope, entry),
        beginWorkspaceScmOperation: (scope: any, operation: any) => state.beginWorkspaceScmOperation(scope, operation),
        finishWorkspaceScmOperation: (scope: any, operationId: any) => state.finishWorkspaceScmOperation(scope, operationId),
        updateWorkspaceScmSnapshot: (scope: any, snapshot: any) => state.updateWorkspaceScmSnapshot(scope, snapshot),
        updateWorkspaceScmSnapshotError: (scope: any, error: any) => state.updateWorkspaceScmSnapshotError(scope, error),
        updateWorkspaceScmStatus: (scope: any, status: any) => state.updateWorkspaceScmStatus(scope, status),
        pruneWorkspaceScmTouchedPaths: (scope: any, activePaths: any) => state.pruneWorkspaceScmTouchedPaths(scope, activePaths),
        pruneWorkspaceScmCommitSelectionPaths: (scope: any, activePaths: any) => state.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths),
        pruneWorkspaceScmCommitSelectionPatches: (scope: any, activePaths: any) => state.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths),
    } as any);

    return createStorageModuleStub({
        storage: store as any,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'split'] as const,
    isAtomicCommitStrategy: () => settingsState.isAtomic,
}));

vi.mock('@/hooks/ui/useMountedRef', () => ({
    useMountedRef: () => ({ current: false }),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmChangeInclude: (...args: unknown[]) => machineScmChangeIncludeMock(...args),
    machineScmChangeExclude: (...args: unknown[]) => machineScmChangeExcludeMock(...args),
}));

vi.mock('@/scm/scmRepositoryService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/scm/scmRepositoryService')>();
    return {
        ...actual,
        scmRepositoryService: {
            fetchSnapshotForMachinePath: (...args: unknown[]) => fetchSnapshotForMachinePathMock(...args),
        },
    };
});

describe('useWorkspaceFileScmStageActions', () => {
    it('marks/unmarks workspace commit selection in atomic commit strategy', async () => {
        settingsState.isAtomic = true;
        state.markPaths.mockClear();
        state.unmarkPaths.mockClear();
        state.removePatch.mockClear();
        state.upsertPatch.mockClear();
        state.appendOp.mockClear();

        const { useWorkspaceFileScmStageActions } = await import('./useWorkspaceFileScmStageActions');
        const scope = { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' };

        const hook = await renderHook(() => useWorkspaceFileScmStageActions({
            scope,
            filePath: 'src/a.ts',
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic' as any,
            includeExcludeEnabled: false,
            diffMode: 'pending',
            diffContent: null,
            lineSelectionEnabled: false,
            selectedLineKeys: new Set<string>(),
            refreshAll: async () => {},
            setSelectedLineKeys: () => {},
        }));

        await act(async () => {
            await hook.getCurrent().handleStage(true);
        });
        expect(state.markPaths).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), ['src/a.ts']);
        expect(state.removePatch).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), 'src/a.ts');

        await hook.getCurrent().handleStage(false);
        expect(state.unmarkPaths).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), ['src/a.ts']);
        expect(state.removePatch).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), 'src/a.ts');
    });

    it('reports atomic line-selection persistence failure without clearing selected lines', async () => {
        settingsState.isAtomic = true;
        state.markPaths.mockClear();
        state.unmarkPaths.mockClear();
        state.removePatch.mockClear();
        state.upsertPatch.mockReset();
        state.appendOp.mockClear();
        state.upsertPatch.mockImplementationOnce(() => {
            throw new Error('persist failed');
        });
        const setSelectedLineKeys = vi.fn();

        const { useWorkspaceFileScmStageActions } = await import('./useWorkspaceFileScmStageActions');
        const scope = { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' };

        const hook = await renderHook(() => useWorkspaceFileScmStageActions({
            scope,
            filePath: 'src/a.ts',
            scmSnapshot: {
                capabilities: {
                    writeCommitLineSelection: true,
                },
            } as any,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic' as any,
            includeExcludeEnabled: false,
            diffMode: 'pending',
            diffContent: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '',
            ].join('\n'),
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>(['additions:1']),
            refreshAll: async () => {},
            setSelectedLineKeys,
        }));

        let result: unknown;
        let caught: unknown = null;
        try {
            result = await hook.getCurrent().applySelectedLines();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeNull();
        expect(result).toBe(false);
        expect(setSelectedLineKeys).not.toHaveBeenCalled();
    });

    it('keeps workspace server scope when live-staging a file and refreshing the snapshot', async () => {
        settingsState.isAtomic = false;
        state.beginWorkspaceScmOperation.mockClear();
        state.finishWorkspaceScmOperation.mockClear();
        machineScmChangeIncludeMock.mockClear();
        fetchSnapshotForMachinePathMock.mockClear();

        const { useWorkspaceFileScmStageActions } = await import('./useWorkspaceFileScmStageActions');
        const scope = { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' };

        const hook = await renderHook(() => useWorkspaceFileScmStageActions({
            scope,
            filePath: 'src/a.ts',
            scmSnapshot: {
                repo: { isRepo: true, rootPath: '/repo' },
                capabilities: {
                    writeInclude: true,
                    writeExclude: true,
                },
                hasConflicts: false,
                totals: {},
                entries: [],
            } as any,
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging' as any,
            includeExcludeEnabled: true,
            diffMode: 'pending',
            diffContent: null,
            lineSelectionEnabled: false,
            selectedLineKeys: new Set<string>(),
            refreshAll: async () => {},
            setSelectedLineKeys: () => {},
        }));

        await hook.getCurrent().handleStage(true);

        expect(machineScmChangeIncludeMock).toHaveBeenCalledWith(
            'machine-1',
            { cwd: '/repo', paths: ['src/a.ts'] },
            { serverId: 'server-1' },
        );
        expect(fetchSnapshotForMachinePathMock).toHaveBeenCalledWith({
            serverId: 'server-1',
            machineId: 'machine-1',
            path: '/repo',
        });
    });
});
