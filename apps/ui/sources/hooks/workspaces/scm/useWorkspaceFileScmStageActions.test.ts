import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    markPaths: vi.fn(),
    unmarkPaths: vi.fn(),
    removePatch: vi.fn(),
    appendOp: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({
        markWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.markPaths(scope, paths),
        unmarkWorkspaceScmCommitSelectionPaths: (scope: any, paths: any) => state.unmarkPaths(scope, paths),
        removeWorkspaceScmCommitSelectionPatch: (scope: any, path: any) => state.removePatch(scope, path),
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
});
