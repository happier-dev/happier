import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: Record<string, unknown>) => value.web ?? value.default,
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/workspaces/scm/states', () => ({
    SourceControlUnavailableState: 'SourceControlUnavailableState',
}));

vi.mock('@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex', () => ({
    useScmTreeBadgeIndex: () => null,
}));

const repositoryTreeBrowserState = vi.hoisted(() => ({
    rootLoading: false,
    rootError: null as string | null,
    nodes: [
        { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
        { path: 'README.md', name: 'README.md', type: 'file', depth: 0 },
    ] as any[],
}));

vi.mock('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser', () => ({
    useWorkspaceRepositoryTreeBrowser: () => ({
        rootLoading: repositoryTreeBrowserState.rootLoading,
        rootError: repositoryTreeBrowserState.rootError,
        nodes: repositoryTreeBrowserState.nodes,
        toggleDirectory: vi.fn(),
        retryRoot: vi.fn(),
        retryDirectory: vi.fn(),
    }),
}));

const latestFilesystemBrowserProps = vi.hoisted(() => ({
    current: null as any,
}));

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowser', () => ({
    FilesystemBrowser: (props: any) => {
        latestFilesystemBrowserProps.current = props;
        return React.createElement(
            'View',
            { testID: 'workspace-repository-tree-list' },
            ...(props.nodes ?? []).map((node: any, index: number) => React.createElement(
                React.Fragment,
                { key: node.path },
                props.renderRow({ node, showDivider: index < props.nodes.length - 1 }),
            )),
        );
    },
}));

vi.mock('@/components/workspaces/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => React.createElement('View', { testID: props.testID }, props.children),
}));

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowserRow', () => ({
    FilesystemBrowserRow: (props: any) => {
        const content = React.createElement('FilesystemBrowserRow', { testID: props.testID, title: props.title });
        if (typeof props.wrapContent === 'function') {
            return props.wrapContent({ node: props.node, content });
        }
        return content;
    },
}));

describe('WorkspaceRepositoryTreeList', () => {
    const theme = {
        colors: {
            text: {
                link: '#09f',
                secondary: '#aaa',
            },
            surface: {
                pressed: '#222',
            },
            state: {
                neutral: { foreground: '#333' },
                success: { foreground: '#0f0' },
                danger: { foreground: '#f00' },
            },
        },
    } as any;

    beforeEach(() => {
        repositoryTreeBrowserState.rootLoading = false;
        repositoryTreeBrowserState.rootError = null;
        repositoryTreeBrowserState.nodes = [
            { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
            { path: 'README.md', name: 'README.md', type: 'file', depth: 0 },
        ];
        latestFilesystemBrowserProps.current = null;
    });

    it('assigns one repository-tree row testID per shared workspace tree row on web', async () => {
        const { WorkspaceRepositoryTreeList } = await import('./WorkspaceRepositoryTreeList');
        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                onWebDropTargetChange={() => {}}
            />,
        );

        const srcRows = screen.findAllByTestId(`repository-tree-row-${toTestIdSafeValue('src')}`)
            .filter((node) => typeof node.type === 'string');
        const readmeRows = screen.findAllByTestId(`repository-tree-row-${toTestIdSafeValue('README.md')}`)
            .filter((node) => typeof node.type === 'string');

        expect(srcRows).toHaveLength(1);
        expect(readmeRows).toHaveLength(1);
    });

    it('reports root loading and can suppress the inline loading header while rows stay mounted', async () => {
        repositoryTreeBrowserState.rootLoading = true;
        const onRootLoadingChange = vi.fn();
        const { WorkspaceRepositoryTreeList } = await import('./WorkspaceRepositoryTreeList');

        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                showInlineLoadingHeader={false}
                onRootLoadingChange={onRootLoadingChange}
            />,
        );

        expect(onRootLoadingChange).toHaveBeenCalledWith(true);
        expect(latestFilesystemBrowserProps.current?.rootLoading).toBe(true);
        expect(latestFilesystemBrowserProps.current?.showInlineLoadingHeader).toBe(false);
        expect(screen.findAllByTestId(`repository-tree-row-${toTestIdSafeValue('src')}`).length).toBeGreaterThan(0);
    });

    it('keeps file browser row plumbing stable when equivalent row actions change identity', async () => {
        const { WorkspaceRepositoryTreeList } = await import('./WorkspaceRepositoryTreeList');

        function Wrapper() {
            const [version, setVersion] = React.useState(0);
            const renderRowActions = React.useCallback((_node: any) => {
                void version;
                return null;
            }, [version]);
            return (
                <>
                    <WorkspaceRepositoryTreeList
                        theme={theme}
                        scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                        expandedPaths={[]}
                        onExpandedPathsChange={() => {}}
                        onOpenFile={() => {}}
                        renderRowActions={renderRowActions}
                    />
                    {React.createElement('Pressable' as any, {
                        testID: 'rerender-parent',
                        onPress: () => setVersion((value) => value + 1),
                    })}
                </>
            );
        }

        const screen = await renderScreen(<Wrapper />);
        const before = latestFilesystemBrowserProps.current;

        await act(async () => {
            screen.pressByTestId('rerender-parent');
        });
        const after = latestFilesystemBrowserProps.current;

        expect(after?.renderRow).toBe(before?.renderRow);
        expect(after?.extraData).toBe(before?.extraData);
    });
});
