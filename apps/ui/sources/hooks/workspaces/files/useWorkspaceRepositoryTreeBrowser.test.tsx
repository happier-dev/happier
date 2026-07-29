import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let latestLazyDirectoryTreeInput: any = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: vi.fn(),
}));

vi.mock('@/hooks/ui/filesystem/useLazyDirectoryTree', () => ({
    useLazyDirectoryTree: (input: any) => {
        latestLazyDirectoryTreeInput = input;
        return {
            rootLoading: false,
            rootError: null,
            nodes: [],
            toggleDirectory: vi.fn(),
            collapseAll: vi.fn(),
            expandedCount: 0,
            retryRoot: vi.fn(),
            retryDirectory: vi.fn(),
        };
    },
}));

describe('useWorkspaceRepositoryTreeBrowser', () => {
    it('forces mounted trees to reload when the workspace directory cache is cleared', async () => {
        latestLazyDirectoryTreeInput = null;

        const { clearCachedWorkspaceRepositoryDirectoryEntries } = await import(
            '@/sync/domains/workspaces/files/workspaceRepositoryDirectory'
        );
        const { useWorkspaceRepositoryTreeBrowser } = await import('./useWorkspaceRepositoryTreeBrowser');

        function Test() {
            useWorkspaceRepositoryTreeBrowser({
                workspaceCacheKey: 'server:m1:/repo',
                machineId: 'm1',
                rootPath: '/repo',
                enabled: true,
                expandedPaths: [],
                onExpandedPathsChange: () => {},
                reloadToken: 0,
            });
            return null;
        }

        await renderScreen(<Test />);

        const initialReloadToken = latestLazyDirectoryTreeInput?.reloadToken;

        act(() => {
            clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: 'server:m1:/repo' });
        });

        await vi.waitFor(() => {
            expect(latestLazyDirectoryTreeInput?.reloadToken).not.toBe(initialReloadToken);
        });
    });
});
