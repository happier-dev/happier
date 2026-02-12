import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
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
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

describe('RepositoryTreeList', () => {
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
});
