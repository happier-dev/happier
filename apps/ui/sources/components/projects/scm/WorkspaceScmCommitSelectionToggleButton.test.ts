import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmChangeExclude, machineScmChangeInclude } from '@/sync/ops/scm/machineScm';

const machineScmChangeIncludeSpy = vi.hoisted(() => vi.fn<typeof machineScmChangeInclude>(async () => ({ success: true })));
const machineScmChangeExcludeSpy = vi.hoisted(() => vi.fn<typeof machineScmChangeExclude>(async () => ({ success: true })));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({}).module;
});

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmChangeInclude: (...args: Parameters<typeof machineScmChangeIncludeSpy>) => machineScmChangeIncludeSpy(...args),
    machineScmChangeExclude: (...args: Parameters<typeof machineScmChangeExcludeSpy>) => machineScmChangeExcludeSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: createStorageStoreMock({
            beginWorkspaceScmOperation: () => ({
                started: true,
                operation: { id: 'op-1', startedAt: 1, sessionId: 'session-1', operation: 'stage' },
            }),
            finishWorkspaceScmOperation: () => true,
            appendWorkspaceScmOperation: () => {},
        } as any),
    });
});

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'server-1:machine-1:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            writeInclude: true,
            writeExclude: true,
        } as any,
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 1,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
    };
}

describe('applyWorkspaceFileStageAction', () => {
    beforeEach(() => {
        machineScmChangeIncludeSpy.mockClear();
        machineScmChangeExcludeSpy.mockClear();
    });

    it('passes the workspace server scope to include RPCs', async () => {
        const { applyWorkspaceFileStageAction } = await import('./WorkspaceScmCommitSelectionToggleButton');

        await applyWorkspaceFileStageAction({
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            filePath: 'src/a.ts',
            snapshot: createSnapshot(),
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            stage: true,
            surface: 'files',
        });

        expect(machineScmChangeIncludeSpy).toHaveBeenCalledWith(
            'machine-1',
            { cwd: '/repo', paths: ['src/a.ts'] },
            { serverId: 'server-1' },
        );
    });

    it('passes the workspace server scope to exclude RPCs', async () => {
        const { applyWorkspaceFileStageAction } = await import('./WorkspaceScmCommitSelectionToggleButton');

        await applyWorkspaceFileStageAction({
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            filePath: 'src/a.ts',
            snapshot: createSnapshot(),
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            stage: false,
            surface: 'files',
        });

        expect(machineScmChangeExcludeSpy).toHaveBeenCalledWith(
            'machine-1',
            { cwd: '/repo', paths: ['src/a.ts'] },
            { serverId: 'server-1' },
        );
    });
});
