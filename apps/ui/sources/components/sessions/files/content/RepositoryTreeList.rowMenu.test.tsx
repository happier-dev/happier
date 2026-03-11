import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionListDirectoryLikeResponse =
    | { success: true; entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> }
    | { success: false; error: string };
type SessionRenamePathLikeResult = { success: true } | { success: false; error: string };
type SessionStatFileLikeResult = { success: true; exists: boolean } | { success: false; error: string };
type SessionDeletePathLikeResult = { success: true } | { success: false; error: string };

const sessionListDirectorySpy = vi.fn<(_sessionId: string, _path: string) => Promise<SessionListDirectoryLikeResponse>>(
    async (_sessionId: string, _path: string) => ({
        success: true,
        entries: [],
    })
);

const sessionRenamePathSpy = vi.fn<(_sessionId: string, _input: { from: string; to: string; overwrite?: boolean }) => Promise<SessionRenamePathLikeResult>>(
    async (_sessionId: string, _input: { from: string; to: string; overwrite?: boolean }) => ({ success: true }),
);
const sessionStatFileSpy = vi.fn<(_sessionId: string, _path: string) => Promise<SessionStatFileLikeResult>>(
    async (_sessionId: string, _path: string) => ({ success: true, exists: false }),
);
const sessionDeletePathSpy = vi.fn<(_sessionId: string, _path: string) => Promise<SessionDeletePathLikeResult>>(
    async (_sessionId: string, _path: string) => ({ success: true }),
);

const modalPromptSpy = vi.fn<IModal['prompt']>(async () => null);
const modalConfirmSpy = vi.fn<IModal['confirm']>(async () => false);
const modalAlertSpy = vi.fn<IModal['alert']>(() => {});
let renameConflictStrategy: 'keep_both' | 'replace' | 'cancel' | null = null;
const modalShowSpy = vi.fn((config: any) => {
    if (!renameConflictStrategy || !config?.component) return 'modal-1';
    const element = config.component({
        ...(config.props ?? {}),
        onClose: vi.fn(),
        onRequestClose: vi.fn(),
    });

    act(() => {
        element.props.onResolve?.(renameConflictStrategy);
    });
    return 'modal-1';
});

const setClipboardStringSafeSpy = vi.fn(async (_value: string) => true);

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
        TurboModuleRegistry: { ...stub.TurboModuleRegistry, get: () => ({}) },
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
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionListDirectory: (sessionId: string, path: string) => sessionListDirectorySpy(sessionId, path),
    sessionRenamePath: (sessionId: string, input: { from: string; to: string; overwrite?: boolean }) => sessionRenamePathSpy(sessionId, input),
    sessionStatFile: (sessionId: string, path: string) => sessionStatFileSpy(sessionId, path),
    sessionDeletePath: (sessionId: string, path: string) => sessionDeletePathSpy(sessionId, path),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                textLink: '#08f',
                warning: '#f80',
                success: '#0f0',
                textDestructive: '#f00',
            },
            dark: false,
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#111',
                        surfaceHigh: '#222',
                        divider: '#333',
                        text: '#eee',
                        textSecondary: '#aaa',
                        textLink: '#08f',
                        warning: '#f80',
                        success: '#0f0',
                        textDestructive: '#f00',
                    },
                })
                : value,
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: (title: string, message?: string, options?: Parameters<IModal['prompt']>[2]) => modalPromptSpy(title, message, options),
        confirm: (title: string, message?: string, options?: Parameters<IModal['confirm']>[2]) => modalConfirmSpy(title, message, options),
        alert: (title: string, message?: string, buttons?: Parameters<IModal['alert']>[2]) => modalAlertSpy(title, message, buttons),
        show: (config: Parameters<IModal['show']>[0]) => modalShowSpy(config),
    },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeSpy(value),
}));

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
    } as any;

    beforeEach(() => {
        renameConflictStrategy = null;
        modalShowSpy.mockReset();
        sessionStatFileSpy.mockReset();
        sessionStatFileSpy.mockResolvedValue({ success: true, exists: false });
    });

    function findFileRowActions(tree: renderer.ReactTestRenderer) {
        const actions = tree.root.findAllByType('ItemRowActions' as any);
        const fileActions = actions.find((node: any) => node.props?.actions?.some((action: any) => action.id === 'repository-tree-menuitem-download'));
        expect(fileActions).toBeTruthy();
        return fileActions!;
    }

    function findDirectoryRowActions(tree: renderer.ReactTestRenderer) {
        const actions = tree.root.findAllByType('ItemRowActions' as any);
        const directoryActions = actions.find((node: any) => node.props?.actions?.some((action: any) => action.id === 'repository-tree-menuitem-zip')
            && !node.props?.actions?.some((action: any) => action.id === 'repository-tree-menuitem-download'));
        expect(directoryActions).toBeTruthy();
        return directoryActions!;
    }

    async function pressRowAction(node: any, actionId: string) {
        const action = node.props.actions.find((candidate: any) => candidate.id === actionId);
        expect(action).toBeTruthy();
        await act(async () => {
            await action.onPress();
        });
    }

    it('renders file and directory action menus with the expected items', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();

        sessionListDirectorySpy.mockReset();
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

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });

        await act(async () => {
            await Promise.resolve();
        });

        const fileMenu = findFileRowActions(tree!);
        expect(fileMenu.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(fileMenu.props.compactActionIds).toEqual([]);
        expect(fileMenu.props.actions.map((item: any) => item.id)).toEqual(
            expect.arrayContaining([
                'repository-tree-menuitem-rename',
                'repository-tree-menuitem-delete',
                'repository-tree-menuitem-download',
                'repository-tree-menuitem-zip',
                'repository-tree-menuitem-copy-path',
            ])
        );

        const directoryMenu = findDirectoryRowActions(tree!);
        expect(directoryMenu.props.actions.map((item: any) => item.id)).toEqual(
            expect.arrayContaining([
                'repository-tree-menuitem-rename',
                'repository-tree-menuitem-delete',
                'repository-tree-menuitem-zip',
                'repository-tree-menuitem-copy-path',
            ])
        );
    });

    it('renames a file when the Rename menu item is selected', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });

        modalPromptSpy.mockResolvedValue('README2.md');

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const fileMenu = findFileRowActions(tree!);
        await pressRowAction(fileMenu, 'repository-tree-menuitem-rename');

        expect(modalPromptSpy).toHaveBeenCalledTimes(1);
        expect(sessionRenamePathSpy).toHaveBeenCalledWith('session-1', { from: 'README.md', to: 'README2.md', overwrite: undefined });
    });

    it('offers keep-both rename conflict resolution and retries with a suffixed path', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();
        renameConflictStrategy = 'keep_both';

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [
                { name: 'rename-source.txt', type: 'file' },
                { name: 'rename-target.txt', type: 'file' },
            ],
        });
        modalPromptSpy.mockResolvedValue('rename-target.txt');
        sessionRenamePathSpy
            .mockResolvedValueOnce({ success: false, error: 'Destination already exists' })
            .mockResolvedValueOnce({ success: true });
        sessionStatFileSpy.mockImplementation(async (_sessionId: string, path: string) => ({
            success: true,
            exists: path !== 'rename-target (1).txt',
        }));

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const fileMenu = findFileRowActions(tree!);
        await pressRowAction(fileMenu, 'repository-tree-menuitem-rename');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(sessionStatFileSpy).toHaveBeenCalledWith('session-1', 'rename-target (1).txt');
        expect(sessionRenamePathSpy.mock.calls).toEqual([
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: undefined }],
            ['session-1', { from: 'rename-source.txt', to: 'rename-target (1).txt', overwrite: undefined }],
        ]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('offers replace rename conflict resolution and retries with overwrite=true', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();
        renameConflictStrategy = 'replace';

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [
                { name: 'rename-source.txt', type: 'file' },
                { name: 'rename-target.txt', type: 'file' },
            ],
        });
        modalPromptSpy.mockResolvedValue('rename-target.txt');
        sessionRenamePathSpy
            .mockResolvedValueOnce({ success: false, error: 'Destination already exists' })
            .mockResolvedValueOnce({ success: true });

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const fileMenu = findFileRowActions(tree!);
        await pressRowAction(fileMenu, 'repository-tree-menuitem-rename');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(sessionRenamePathSpy.mock.calls).toEqual([
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: undefined }],
            ['session-1', { from: 'rename-source.txt', to: 'rename-target.txt', overwrite: true }],
        ]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('deletes a directory recursively when Delete is selected', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'src', type: 'directory' }],
        });

        modalConfirmSpy.mockResolvedValue(true);

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const directoryMenu = findDirectoryRowActions(tree!);
        await pressRowAction(directoryMenu, 'repository-tree-menuitem-delete');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(sessionDeletePathSpy).toHaveBeenCalledWith('session-1', { path: 'src', recursive: true });
    });

    it('copies the path when Copy path is selected', async () => {
        modalPromptSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalAlertSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        sessionRenamePathSpy.mockReset();
        sessionDeletePathSpy.mockReset();

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });

        setClipboardStringSafeSpy.mockResolvedValue(true);

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={vi.fn()}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const fileMenu = findFileRowActions(tree!);
        await pressRowAction(fileMenu, 'repository-tree-menuitem-copy-path');

        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('README.md');
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });
});
