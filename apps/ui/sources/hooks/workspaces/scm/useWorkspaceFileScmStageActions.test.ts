import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    markPaths: vi.fn(),
    unmarkPaths: vi.fn(),
    removePatch: vi.fn(),
    upsertPatch: vi.fn(),
    appendOp: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({
        markWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.markPaths(scope, paths),
        unmarkWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.unmarkPaths(scope, paths),
        removeWorkspaceScmCommitSelectionPatch: (scope: any, path: any) => state.removePatch(scope, path),
        upsertWorkspaceScmCommitSelectionPatch: (scope: any, patch: any) => state.upsertPatch(scope, patch),
        appendWorkspaceScmOperation: (scope: any, entry: any) => state.appendOp(scope, entry),
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
    isAtomicCommitStrategy: () => true,
}));

describe('useWorkspaceFileScmStageActions', () => {
    it('marks/unmarks workspace commit selection in atomic commit strategy', async () => {
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

        await hook.getCurrent().handleStage(true);
        expect(state.markPaths).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), ['src/a.ts']);
        expect(state.removePatch).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), 'src/a.ts');

        await hook.getCurrent().handleStage(false);
        expect(state.unmarkPaths).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), ['src/a.ts']);
        expect(state.removePatch).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1' }), 'src/a.ts');
    });

    it('reports atomic line-selection persistence failure without clearing selected lines', async () => {
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
});
