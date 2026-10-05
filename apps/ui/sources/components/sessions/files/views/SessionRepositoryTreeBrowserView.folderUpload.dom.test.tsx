/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';
import { primeRepositoryUploadBrowserFixture } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ success: true, exists: false })));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpcSpy as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

function flattenRnStyle(style: any): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        const merged: Record<string, unknown> = {};
        for (const entry of style) {
            const flattened = flattenRnStyle(entry);
            if (!flattened) continue;
            Object.assign(merged, flattened);
        }
        return merged as React.CSSProperties;
    }
    if (typeof style === 'object') {
        return style as React.CSSProperties;
    }
    return undefined;
}

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
            View: ({
                testID,
                children,
                onLayout: _onLayout,
                style,
                accessibilityLabel: _accessibilityLabel,
                accessibilityRole: _accessibilityRole,
                ...props
            }: any) =>
                React.createElement('div', { 'data-testid': testID, style: flattenRnStyle(style), ...props }, children),
            Text: ({
                testID,
                children,
                style,
                accessibilityLabel: _accessibilityLabel,
                accessibilityRole: _accessibilityRole,
                ...props
            }: any) =>
                React.createElement('span', { 'data-testid': testID, style: flattenRnStyle(style), ...props }, children),
            Pressable: ({
                testID,
                onPress,
                children,
                accessibilityLabel,
                accessibilityRole,
                hitSlop: _hitSlop,
                style,
                ...props
            }: any) =>
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        'data-testid': testID,
                        'aria-label': accessibilityLabel,
                        role: accessibilityRole,
                        onClick: onPress,
                        style: flattenRnStyle(style),
                        ...props,
                    },
                    children,
                ),
            TextInput: ({
                testID,
                onChangeText,
                children,
                accessibilityLabel: _accessibilityLabel,
                accessibilityRole: _accessibilityRole,
                placeholderTextColor: _placeholderTextColor,
                autoCorrect: _autoCorrect,
                clearButtonMode: _clearButtonMode,
                style,
                ...props
            }: any) =>
                React.createElement(
                    'input',
                    {
                        'data-testid': testID,
                        onChange: (event: any) => onChangeText?.(event.target.value),
                        style: flattenRnStyle(style),
                        ...props,
                    },
                    children,
                ),
            ScrollView: ({
                testID,
                children,
                style,
                accessibilityLabel: _accessibilityLabel,
                accessibilityRole: _accessibilityRole,
                ...props
            }: any) =>
                React.createElement('div', { 'data-testid': testID, style: flattenRnStyle(style), ...props }, children),
            ActivityIndicator: ({
                testID,
                accessibilityLabel: _accessibilityLabel,
                accessibilityRole: _accessibilityRole,
                ...props
            }: any) =>
                React.createElement('span', { 'data-testid': testID, ...props }),
        });
    },
    storage: (importOriginal) => importOriginal(),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: ({ accessibilityLabel: _accessibilityLabel, accessibilityRole: _accessibilityRole, ...props }: any) => React.createElement('span', props),
    Ionicons: ({ accessibilityLabel: _accessibilityLabel, accessibilityRole: _accessibilityRole, ...props }: any) => React.createElement('span', props),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('div'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('div'),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: ({ trigger }: any) => React.createElement(React.Fragment, null, trigger({ toggle: vi.fn() })),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: ({
        accessibilityLabel: _accessibilityLabel,
        accessibilityRole: _accessibilityRole,
        ...props
    }: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/sessions/files/repositoryTree/RepositoryTreeDropOverlay', () => ({
    RepositoryTreeDropOverlay: () => null,
}));

vi.mock('@/components/sessions/files/repositoryTree/RepositoryTreeTransferStatusBar', () => ({
    RepositoryTreeTransferStatusBar: () => null,
}));

vi.mock('@/components/sessions/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: ({
        children,
        testID,
        accessibilityLabel: _accessibilityLabel,
        accessibilityRole: _accessibilityRole,
        ...props
    }: any) =>
        React.createElement('div', { 'data-testid': testID, ...props }, children),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: vi.fn(),
        onContentSizeChange: vi.fn(),
        onScroll: vi.fn(),
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/hooks/ui/useWebFileDropZone', () => ({
    useWebFileDropZone: () => ({}),
}));

vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

vi.mock('@/utils/files/nativePickFiles', () => ({
    nativePickFiles: vi.fn(async () => []),
}));

vi.mock('@/components/sessions/files/repositoryTree/showUploadConflictResolutionDialog', () => ({
    showUploadConflictResolutionDialog: vi.fn(async () => 'keep_both'),
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
    fileSearchCache: { clearCache: vi.fn() },
}));

vi.mock('@/components/sessions/agents/presentation/useSessionMachineName', () => ({
    useSessionMachineName: () => 'MacBook Pro',
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
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

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: vi.fn() },
}));

describe('SessionRepositoryTreeBrowserView web folder upload input', () => {
    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await primeRepositoryUploadBrowserFixture();
        machineRpcSpy.mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('starts web uploads from the hidden file input change event', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        serverId="server"
                        searchQuery="initial"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            const fileInput = container.querySelector<HTMLInputElement>('[data-testid="repository-tree-upload-input-files"]');
            if (!fileInput) {
                throw new Error('Missing repository-tree-upload-input-files');
            }
            const file = new File(['uploaded from test'], 'upload-source.txt', { type: 'text/plain' });

            // The input can only acquire files after the mounted owner opens its exact-scope picker.
            expect(await invokeRepositoryUploadPick({
                scope: { serverId: 'server', accountId: 'account' },
                workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
                kind: 'files', destinationDir: '',
            })).toEqual({ status: 'requested' });

            await act(async () => {
                Object.defineProperty(fileInput, 'files', {
                    configurable: true,
                    value: [file],
                });
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            });

            expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
                serverId: 'server', machineId: 'm1', method: RPC_METHODS.STAT_FILE,
                payload: { path: '/repo/upload-source.txt' },
            }));
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('keeps directory-selection attributes on the hidden folder input after rerenders', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        searchQuery="initial"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            const folderInput = container.querySelector<HTMLInputElement>('[data-testid="repository-tree-upload-input-folder"]');
            if (!folderInput) {
                throw new Error('Missing repository-tree-upload-input-folder');
            }
            expect(folderInput.hasAttribute('webkitdirectory')).toBe(true);
            expect(folderInput.hasAttribute('directory')).toBe(true);
            expect(folderInput.multiple).toBe(true);

            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        searchQuery="next"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            expect(folderInput.hasAttribute('webkitdirectory')).toBe(true);
            expect(folderInput.hasAttribute('directory')).toBe(true);
            expect(folderInput.multiple).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
