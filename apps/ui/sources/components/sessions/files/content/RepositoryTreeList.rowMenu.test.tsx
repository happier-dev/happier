import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SessionListDirectoryLikeResponse =
    | { success: true; entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> }
    | { success: false; error: string };
type SessionRenamePathLikeResult = { success: true } | { success: false; error: string };
type SessionStatFileLikeResult = { success: true; exists: boolean } | { success: false; error: string };
type SessionDeletePathLikeResult = { success: true } | { success: false; error: string };

const {
    sessionListDirectorySpy,
    sessionRenamePathSpy,
    sessionStatFileSpy,
    sessionDeletePathSpy,
    downloadAvailabilityState,
    modalShowStrategy,
    renameConflictStrategyState,
    modalPromptSpy,
    modalConfirmSpy,
    modalAlertSpy,
    setClipboardStringSafeSpy,
} = vi.hoisted(() => {
    const renameConflictStrategy: { value: 'keep_both' | 'replace' | 'cancel' | null } = {
        value: null,
    };

    const modalShowStrategy = vi.fn((config: any) => {
        if (!renameConflictStrategy.value || !config?.component) return 'modal-1';

        const element = config.component({
            ...(config.props ?? {}),
            onClose: vi.fn(),
            onRequestClose: vi.fn(),
        });

        queueMicrotask(() => {
            act(() => {
                element.props.onResolve?.(renameConflictStrategy.value);
            });
        });

        return 'modal-1';
    });

    return {
        sessionListDirectorySpy: vi.fn<(_sessionId: string, _path: string) => Promise<SessionListDirectoryLikeResponse>>(
            async (_sessionId: string, _path: string) => ({
                success: true,
                entries: [],
            }),
        ),
        sessionRenamePathSpy: vi.fn<(_sessionId: string, _input: { from: string; to: string; overwrite?: boolean }) => Promise<SessionRenamePathLikeResult>>(
            async (_sessionId: string, _input: { from: string; to: string; overwrite?: boolean }) => ({ success: true }),
        ),
        sessionStatFileSpy: vi.fn<(_sessionId: string, _path: string) => Promise<SessionStatFileLikeResult>>(
            async (_sessionId: string, _path: string) => ({ success: true, exists: false }),
        ),
        sessionDeletePathSpy: vi.fn<(_sessionId: string, _path: string) => Promise<SessionDeletePathLikeResult>>(
            async (_sessionId: string, _path: string) => ({ success: true }),
        ),
        downloadAvailabilityState: { value: true },
        modalShowStrategy,
        renameConflictStrategyState: renameConflictStrategy,
        modalPromptSpy: vi.fn(async (): Promise<string | null> => null),
        modalConfirmSpy: vi.fn(async () => false),
        modalAlertSpy: vi.fn(() => {}),
        setClipboardStringSafeSpy: vi.fn(async (_value: string) => true),
    };
});

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
                const header = ListHeaderComponent
                    ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
                    : null;
                const items = (data ?? []).map((item: any, index: number) => {
                    const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
                    return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                });
                return React.createElement('FlatList', null, header, ...items);
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        return {
            Modal: {
                ...modalMock.module.Modal,
                show: modalShowStrategy,
                prompt: modalPromptSpy,
                confirm: modalConfirmSpy,
                alert: modalAlertSpy,
                hide: vi.fn(),
            },
        } as any;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeSpy(value),
}));

vi.mock('@/sync/ops', () => ({
    sessionListDirectory: (sessionId: string, path: string) => sessionListDirectorySpy(sessionId, path),
    sessionRenamePath: (sessionId: string, input: { from: string; to: string; overwrite?: boolean }) => sessionRenamePathSpy(sessionId, input),
    sessionStatFile: (sessionId: string, path: string) => sessionStatFileSpy(sessionId, path),
    sessionDeletePath: (sessionId: string, path: string) => sessionDeletePathSpy(sessionId, path),
}));

vi.mock('@/components/sessions/files/useSessionFileDownloadAvailability', () => ({
    useSessionFileDownloadAvailability: () => downloadAvailabilityState.value,
}));

afterEach(() => {
    standardCleanup();
});

describe('RepositoryTreeList (row menu)', () => {
    const theme = {
        colors: {
            surface: '#111',
            surfaceHigh: '#222',
            divider: '#333',
            text: '#eee',
            textSecondary: '#aaa',
            textLink: '#08f',
        },
        dark: false,
    } as const;

    beforeEach(() => {
        modalShowStrategy.mockClear();
        renameConflictStrategyState.value = null;
        modalPromptSpy.mockClear();
        modalConfirmSpy.mockClear();
        modalAlertSpy.mockClear();
        sessionListDirectorySpy.mockClear();
        sessionRenamePathSpy.mockClear();
        sessionStatFileSpy.mockClear();
        sessionDeletePathSpy.mockClear();
        setClipboardStringSafeSpy.mockClear();
        modalPromptSpy.mockResolvedValue(null);
        modalConfirmSpy.mockResolvedValue(false);
        modalAlertSpy.mockImplementation(() => {});
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [],
        });
        sessionRenamePathSpy.mockResolvedValue({ success: true });
        sessionStatFileSpy.mockResolvedValue({ success: true, exists: false });
        sessionDeletePathSpy.mockResolvedValue({ success: true });
        setClipboardStringSafeSpy.mockResolvedValue(true);
        downloadAvailabilityState.value = true;
    });

    async function renderRepositoryTreeList(params: Readonly<{ downloadActionsAvailable?: boolean }> = {}) {
        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    onRequestDownload={params.downloadActionsAvailable === false
                        ? null
                        : async () => ({ ok: true as const })}
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        return renderScreen(React.createElement(Wrapper));
    }

    function findRowActions(screen: Awaited<ReturnType<typeof renderScreen>>, path: string) {
        const row = screen.findByTestId(`repository-tree-row-${toTestIdSafeValue(path)}`);
        expect(row).toBeTruthy();

        const actionHosts = row!.findAllByType('ItemRowActions' as any);
        expect(actionHosts.length).toBeGreaterThan(0);
        return actionHosts[0]!;
    }

    async function pressRowAction(screen: Awaited<ReturnType<typeof renderScreen>>, path: string, actionId: string) {
        const actionHost = findRowActions(screen, path);
        const action = actionHost.props.actions.find((candidate: any) => candidate.id === actionId);
        expect(action).toBeTruthy();

        await act(async () => {
            await action.onPress();
        });
    }

    it('renders file and directory action menus with the expected items', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            return {
                success: true,
                entries: [
                    { name: 'src', type: 'directory' },
                    { name: 'README.md', type: 'file' },
                ],
            };
        });

        const screen = await renderRepositoryTreeList();

        expect(screen.findByTestId(`repository-tree-row-${toTestIdSafeValue('README.md')}`)).toBeTruthy();
        expect(screen.findByTestId(`repository-tree-row-${toTestIdSafeValue('src')}`)).toBeTruthy();

        const fileMenu = findRowActions(screen, 'README.md');
        expect(fileMenu.props.overflowTriggerTestID).toBe(`repository-tree-row-menu-${toTestIdSafeValue('README.md')}`);
        expect(fileMenu.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(fileMenu.props.compactActionIds).toEqual([]);
        expect(fileMenu.props.actions.map((item: any) => item.id)).toEqual([
            'repository-tree-menuitem-rename',
            'repository-tree-menuitem-delete',
            'repository-tree-menuitem-download',
            'repository-tree-menuitem-zip',
            'repository-tree-menuitem-copy-path',
        ]);

        const directoryMenu = findRowActions(screen, 'src');
        expect(directoryMenu.props.actions.map((item: any) => item.id)).toEqual([
            'repository-tree-menuitem-rename',
            'repository-tree-menuitem-delete',
            'repository-tree-menuitem-zip',
            'repository-tree-menuitem-copy-path',
        ]);
    });

    it('omits download actions when file downloads are unavailable', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            return {
                success: true,
                entries: [
                    { name: 'src', type: 'directory' },
                    { name: 'README.md', type: 'file' },
                ],
            };
        });

        const screen = await renderRepositoryTreeList({ downloadActionsAvailable: false });

        const fileMenu = findRowActions(screen, 'README.md');
        expect(fileMenu.props.actions.map((item: any) => item.id)).toEqual([
            'repository-tree-menuitem-rename',
            'repository-tree-menuitem-delete',
            'repository-tree-menuitem-copy-path',
        ]);

        const directoryMenu = findRowActions(screen, 'src');
        expect(directoryMenu.props.actions.map((item: any) => item.id)).toEqual([
            'repository-tree-menuitem-rename',
            'repository-tree-menuitem-delete',
            'repository-tree-menuitem-copy-path',
        ]);
    });

    it('omits download actions when the session download route is unavailable (even if a callback exists)', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            return {
                success: true,
                entries: [{ name: 'README.md', type: 'file' }],
            };
        });
        downloadAvailabilityState.value = false;

        const screen = await renderRepositoryTreeList();

        const fileMenu = findRowActions(screen, 'README.md');
        expect(fileMenu.props.actions.map((item: any) => item.id)).toEqual([
            'repository-tree-menuitem-rename',
            'repository-tree-menuitem-delete',
            'repository-tree-menuitem-copy-path',
        ]);
    });

    it('renames a file when the Rename menu item is selected', async () => {
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });
        modalPromptSpy.mockResolvedValue('README2.md');

        const screen = await renderRepositoryTreeList();
        await pressRowAction(screen, 'README.md', 'repository-tree-menuitem-rename');

        expect(modalPromptSpy).toHaveBeenCalledTimes(1);
        expect(sessionRenamePathSpy).toHaveBeenCalledWith('session-1', { from: 'README.md', to: 'README2.md', overwrite: undefined });
    });

    it('offers keep-both rename conflict resolution and retries with a suffixed path', async () => {
        renameConflictStrategyState.value = 'keep_both';
        modalPromptSpy.mockResolvedValue('rename-target.txt');
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [
                { name: 'rename-source.txt', type: 'file' },
                { name: 'rename-target.txt', type: 'file' },
            ],
        });
        sessionRenamePathSpy
            .mockResolvedValueOnce({ success: false, error: 'Destination already exists' })
            .mockResolvedValueOnce({ success: true });
        sessionStatFileSpy.mockImplementation(async (_sessionId: string, path: string) => ({
            success: true,
            exists: path !== 'rename-target (1).txt',
        }));

        const screen = await renderRepositoryTreeList();
        await pressRowAction(screen, 'rename-source.txt', 'repository-tree-menuitem-rename');
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(modalShowStrategy).toHaveBeenCalledTimes(1);
        expect(sessionStatFileSpy).toHaveBeenCalledWith('session-1', 'rename-target (1).txt');
        expect(sessionRenamePathSpy.mock.calls).toEqual([
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: undefined }],
            ['session-1', { from: 'rename-source.txt', to: 'rename-target (1).txt', overwrite: undefined }],
        ]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('offers replace rename conflict resolution and retries with overwrite=true', async () => {
        renameConflictStrategyState.value = 'replace';
        modalPromptSpy.mockResolvedValue('rename-target.txt');
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [
                { name: 'rename-source.txt', type: 'file' },
                { name: 'rename-target.txt', type: 'file' },
            ],
        });
        sessionRenamePathSpy
            .mockResolvedValueOnce({ success: false, error: 'Destination already exists' })
            .mockResolvedValueOnce({ success: true });

        const screen = await renderRepositoryTreeList();
        await pressRowAction(screen, 'rename-source.txt', 'repository-tree-menuitem-rename');
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(modalShowStrategy).toHaveBeenCalledTimes(1);
        expect(sessionRenamePathSpy.mock.calls).toEqual([
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: undefined }],
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: true }],
        ]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('deletes a directory recursively when Delete is selected', async () => {
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'src', type: 'directory' }],
        });
        modalConfirmSpy.mockResolvedValue(true);

        const screen = await renderRepositoryTreeList();
        await pressRowAction(screen, 'src', 'repository-tree-menuitem-delete');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(sessionDeletePathSpy).toHaveBeenCalledWith('session-1', { path: 'src', recursive: true });
    });

    it('copies the path when Copy path is selected', async () => {
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });
        setClipboardStringSafeSpy.mockResolvedValue(true);

        const screen = await renderRepositoryTreeList();
        await pressRowAction(screen, 'README.md', 'repository-tree-menuitem-copy-path');

        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('README.md');
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });
});
