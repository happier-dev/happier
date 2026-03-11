import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionListDirectoryLikeResponse =
    | { success: true; entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> }
    | { success: false; error: string };

const sessionListDirectorySpy = vi.fn<(_sessionId: string, _path: string) => Promise<SessionListDirectoryLikeResponse>>(
    async (_sessionId: string, _path: string) => ({
        success: true,
        entries: [],
    })
);

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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/sessions/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => React.createElement('WebDropTargetView', props, props.children),
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

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(async () => null),
        confirm: vi.fn(async () => false),
        alert: vi.fn(() => {}),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionListDirectory: (sessionId: string, path: string) => sessionListDirectorySpy(sessionId, path),
}));

const mockTheme = {
    colors: {
        surface: '#111',
        surfaceHigh: '#222',
        surfaceHighest: '#2a2a2a',
        surfacePressed: '#1b1b1b',
        surfacePressedOverlay: 'rgba(255, 255, 255, 0.08)',
        surfaceSelected: '#191919',
        divider: '#333',
        text: '#eee',
        textSecondary: '#aaa',
        textLink: '#08f',
        accent: {
            blue: '#08f',
        },
        warning: '#f80',
        success: '#0f0',
        textDestructive: '#f00',
        deleteAction: '#f44',
        button: {
            secondary: {
                tint: '#08f',
            },
        },
        modal: {
            border: '#444',
        },
        shadow: {
            color: '#000',
            opacity: 0.2,
        },
    },
    dark: false,
} as const;

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: mockTheme,
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value(mockTheme)
                : value,
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

describe('RepositoryTreeList', () => {
    const theme = mockTheme as any;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders an error state when directory listing fails', async () => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: false,
            error: 'offline',
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
            tree = renderer.create(
                <Wrapper />
            );
        });

        const errorWrapper = (tree! as any).root.findAll((node: any) => node.props?.testID === 'repository-tree-error');
        expect(errorWrapper.length).toBe(1);
    });

    it('orders directories before files and supports expanding a directory', async () => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [
                        { name: 'README.md', type: 'file' },
                        { name: 'src', type: 'directory' },
                    ],
                };
            }
            if (path === 'src') {
                return {
                    success: true,
                    entries: [
                        { name: 'a.ts', type: 'file' },
                    ],
                };
            }
            return { success: true, entries: [] };
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
            tree = renderer.create(
                <Wrapper />
            );
        });

        const itemsBeforeExpand = (tree! as any).root.findAllByType('Item');
        expect(itemsBeforeExpand.map((item: any) => item.props.title)).toEqual(['src/', 'README.md']);
        expect(itemsBeforeExpand.every((item: any) => item.props.density === 'tight')).toBe(true);

        await act(async () => {
            itemsBeforeExpand[0].props.onPress();
        });

        const itemsAfterExpand = (tree! as any).root.findAllByType('Item');
        const titles = itemsAfterExpand.map((item: any) => item.props.title);
        expect(titles).toContain('a.ts');
    });

    it('shows a folder load error row instead of an empty tree when a child directory cannot be loaded', async () => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [
                        { name: 'src', type: 'directory' },
                    ],
                };
            }
            if (path === 'src') {
                return {
                    success: false,
                    error: 'permission denied',
                };
            }
            return { success: true, entries: [] };
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
            tree = renderer.create(
                <Wrapper />
            );
        });

        const itemsBeforeExpand = (tree! as any).root.findAllByType('Item');
        await act(async () => {
            itemsBeforeExpand[0].props.onPress();
        });

        const itemsAfterExpand = (tree! as any).root.findAllByType('Item');
        const titles = itemsAfterExpand.map((item: any) => item.props.title);
        expect(titles).toContain('files.repositoryFolderLoadFailed');
    });

    it('pins a file when double-pressed', async () => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });

        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();
        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            return (
                <RepositoryTreeList
                    theme={theme}
                    sessionId="session-1"
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
                    onOpenFile={onOpenFile}
                    onOpenFilePinned={onOpenFilePinned}
                />
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });

        const items = (tree! as any).root.findAllByType('Item');
        const readme = items.find((item: any) => item.props.title === 'README.md');
        expect(readme).toBeTruthy();
        expect(typeof readme.props.onDoublePress).toBe('function');

        await act(async () => {
            readme.props.onDoublePress();
        });

        expect(onOpenFilePinned).toHaveBeenCalledWith('README.md');
        expect(onOpenFile).toHaveBeenCalledTimes(0);
    });

    it('routes file-row drag hover to the parent directory destination', async () => {
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

        const onWebDropTargetChange = vi.fn();
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
                    {...({ onWebDropTargetChange } as any)}
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

        const dropTargets = (tree! as any).root.findAllByType('WebDropTargetView');
        const fileTarget = dropTargets.find((target: any) => {
            const row = target.findAllByType('Item')[0];
            return row?.props?.title === 'README.md';
        });
        expect(fileTarget).toBeTruthy();

        await act(async () => {
            const stopPropagation = vi.fn();
            fileTarget.props.onDragEnter({
                dataTransfer: { types: ['Files'] },
                stopPropagation,
            });
            expect(stopPropagation).not.toHaveBeenCalled();
        });

        expect(onWebDropTargetChange).toHaveBeenCalledWith({
            destinationDir: '',
            hoverPath: 'README.md',
            autoExpandDirectoryPath: null,
        });
    });

    it('marks a hovered collapsed directory for delayed auto-expand', async () => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [{ name: 'src', type: 'directory' }],
                };
            }
            if (path === 'src') {
                return {
                    success: true,
                    entries: [{ name: 'a.ts', type: 'file' }],
                };
            }
            return { success: true, entries: [] };
        });

        const onWebDropTargetChange = vi.fn();
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
                    {...({ onWebDropTargetChange } as any)}
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

        const dropTargets = (tree! as any).root.findAllByType('WebDropTargetView');
        const directoryTarget = dropTargets.find((target: any) => {
            const row = target.findAllByType('Item')[0];
            return row?.props?.title === 'src/';
        });
        expect(directoryTarget).toBeTruthy();

        await act(async () => {
            const stopPropagation = vi.fn();
            directoryTarget.props.onDragEnter({
                dataTransfer: { types: ['Files'] },
                stopPropagation,
            });
            expect(stopPropagation).not.toHaveBeenCalled();
        });

        expect(onWebDropTargetChange).toHaveBeenCalledWith({
            destinationDir: 'src',
            hoverPath: 'src',
            autoExpandDirectoryPath: 'src',
        });
    });

    it('keeps the previous tree visible while reloading the root directory', async () => {
        const deferred = () => {
            let resolve: ((value: SessionListDirectoryLikeResponse) => void) | null = null;
            const promise = new Promise<SessionListDirectoryLikeResponse>((res) => {
                resolve = res;
            });
            return { promise, resolve: resolve! };
        };

        const pending = deferred();
        let rootCalls = 0;

        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            rootCalls += 1;
            if (rootCalls === 1) {
                return {
                    success: true,
                    entries: [
                        { name: 'README.md', type: 'file' },
                        { name: 'src', type: 'directory' },
                    ],
                };
            }
            return await pending.promise;
        });

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            const [reloadToken, setReloadToken] = React.useState(0);
            return (
                <>
                    <RepositoryTreeList
                        theme={theme}
                        sessionId="session-1"
                        reloadToken={reloadToken}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={setExpandedPaths}
                        onOpenFile={vi.fn()}
                    />
                    {React.createElement('Pressable' as any, { testID: 'reload-root', onPress: () => setReloadToken((v) => v + 1) })}
                </>
            );
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Wrapper />);
        });

        // Wait for initial root load to complete.
        await act(async () => {
            await Promise.resolve();
        });

        const itemsBeforeReload = (tree! as any).root.findAllByType('Item');
        expect(itemsBeforeReload.map((item: any) => item.props.title)).toEqual(['src/', 'README.md']);

        // Trigger reload, but keep the root request pending to observe the loading state.
        const reload = (tree! as any).root.findByProps({ testID: 'reload-root' });
        await act(async () => {
            reload.props.onPress();
        });

        const itemsDuringReload = (tree! as any).root.findAllByType('Item');
        expect(itemsDuringReload.map((item: any) => item.props.title)).toEqual(['src/', 'README.md']);
        // Inline loading indicator should be visible (centered loading should not replace the tree).
        expect((tree! as any).root.findAllByType('ActivityIndicator').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            pending.resolve({
                success: true,
                entries: [
                    { name: 'src', type: 'directory' },
                ],
            });
            await Promise.resolve();
        });

        const itemsAfterReload = (tree! as any).root.findAllByType('Item');
        expect(itemsAfterReload.map((item: any) => item.props.title)).toEqual(['src/']);
    });
});
