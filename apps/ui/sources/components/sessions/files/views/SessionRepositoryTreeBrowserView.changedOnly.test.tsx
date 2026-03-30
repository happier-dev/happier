import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setExpandedPathsSpy = vi.fn();

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: setExpandedPathsSpy }) } as any,
            useSession: () => ({ active: true, metadata: { machineId: 'm1' } }) as any,
            useProjectForSession: () => ({ key: { machineId: 'm1', path: '/repo' } }) as any,
            useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }] as any,
            useMachine: () => ({ id: 'm1' }) as any,
            useSessionRepositoryTreeExpandedPaths: () => ['src'],
            useSessionProjectScmSnapshot: () => ({
                projectKey: 'p',
                fetchedAt: 1,
                repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                capabilities: {} as any,
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                hasConflicts: false,
                entries: [],
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            }) as any,
        });
    },
});

vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: vi.fn(async () => ({ ok: true })),
        cancelUploads: vi.fn(),
        startDownload: vi.fn(async () => ({ ok: true })),
        cancelDownload: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: () => {} },
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: () => React.createElement('View', { testID: 'repository-tree-list' }),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('View', { testID: 'changed-files-tree-list' }),
}));

vi.mock('@/components/sessions/files/views/repositoryTreeBrowser/RepositoryTreeChangedFilesPane', () => ({
    RepositoryTreeChangedFilesPane: () => React.createElement('View', { testID: 'repository-tree-changed-files-pane' }),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: vi.fn(async () => ({ success: true })),
    sessionCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: () => true,
}));

vi.mock('@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

describe('SessionRepositoryTreeBrowserView (changed-only toggle)', () => {
    afterEach(() => {
        standardCleanup();
    });

    async function renderRepositoryTreeBrowserView() {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        return renderScreen(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    }

    it('toggles between full repository tree and changed-only tree', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
        expect(screen.findAllByTestId('changed-files-tree-list')).toHaveLength(0);
        expect(screen.findAllByTestId('repository-tree-changed-files-pane')).toHaveLength(0);

        expect(screen.findAllByTestId('repository-tree-filter-changed').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('repository-tree-filter-changed');
        });

        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(0);
        expect(screen.findAllByTestId('changed-files-tree-list')).toHaveLength(0);
        expect(screen.findAllByTestId('repository-tree-changed-files-pane')).toHaveLength(1);
    });

    it('renders a collapse-all button when folders are expanded', async () => {
        setExpandedPathsSpy.mockClear();

        const screen = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByTestId('repository-tree-collapse-all').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('repository-tree-collapse-all');
        });

        expect(setExpandedPathsSpy).toHaveBeenCalledWith('s1', []);
    });
});
