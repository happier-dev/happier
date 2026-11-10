import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { WorkspaceRepositoryTreeList } from './WorkspaceRepositoryTreeList';
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

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

const badgeIndexState = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex', () => ({
    // The web index arrives a tick after the snapshot; tests flip it to model that arrival.
    useScmTreeBadgeIndex: () => badgeIndexState.current,
}));

const repositoryTreeBrowserState = vi.hoisted(() => ({
    rootLoading: false,
    rootLoaded: true,
    liveFileWrites: new Map(),
    arrivedPaths: new Set<string>(),
    rootError: null as string | null,
    nodes: [
        { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
        { path: 'README.md', name: 'README.md', type: 'file', depth: 0 },
    ] as any[],
}));

const toggleDirectorySpy = vi.hoisted(() => ({ current: null as null | ((path: string) => void) }));
const treeBrowserInputs = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser', () => ({
    useWorkspaceRepositoryTreeBrowser: (input: any) => (treeBrowserInputs.current = input, {
        rootLoading: repositoryTreeBrowserState.rootLoading,
        rootLoaded: repositoryTreeBrowserState.rootLoaded,
        rootError: repositoryTreeBrowserState.rootError,
        nodes: repositoryTreeBrowserState.nodes,
        liveFileWrites: repositoryTreeBrowserState.liveFileWrites,
        arrivedPaths: repositoryTreeBrowserState.arrivedPaths,
        toggleDirectory: (path: string) => toggleDirectorySpy.current?.(path),
        retryRoot: vi.fn(),
        retryDirectory: vi.fn(),
    }),
}));

const latestFilesystemBrowserProps = vi.hoisted(() => ({
    current: null as any,
}));

vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: any) => React.createElement('SurfaceStateCard', props),
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
    WebDropTargetView: (props: any) => React.createElement('WebDropTargetView', props, props.children),
}));

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowserRow', () => ({
    FilesystemBrowserRow: (props: any) => {
        const content = React.createElement('FilesystemBrowserRow', {
            testID: props.testID,
            title: props.title,
            selected: props.selected,
            onPress: props.onPress,
            onDoublePress: props.onDoublePress,
            onDisclosurePress: props.onDisclosurePress,
            rowPresentation: props.rowPresentation,
            treeItemProps: props.treeItemProps,
        });
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

    it('names a failed folder load and preserves its retry and diagnostic cause', async () => {
        repositoryTreeBrowserState.rootError = 'RPC method not available';
        repositoryTreeBrowserState.nodes = [];
        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
            />,
        );

        const state = screen.findByTestId('repository-tree-root-error');
        expect(state?.props.title).toBe('files.pane.rootErrorTitleUnnamed');
        expect(state?.props.reason).toBe('errors.daemonUnavailableBody');
        expect(state?.props.diagnosticCode).toBe('RPC method not available');
        expect(state?.props.action?.label).toBe('common.retry');
    });

    it('assigns one repository-tree row testID per shared workspace tree row on web', async () => {
        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                webFileDropEnabled
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

    it('reports no refresh while the root is listed for the first time: the body says it is loading', async () => {
        repositoryTreeBrowserState.rootLoading = true;
        repositoryTreeBrowserState.rootLoaded = false;
        const onRootLoadingChange = vi.fn();
        try {
            await renderScreen(
                <WorkspaceRepositoryTreeList
                    theme={theme}
                    scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                    expandedPaths={[]}
                    onExpandedPathsChange={() => {}}
                    onOpenFile={() => {}}
                    onRootLoadingChange={onRootLoadingChange}
                />,
            );
            expect(onRootLoadingChange).not.toHaveBeenCalledWith(true);
        } finally {
            repositoryTreeBrowserState.rootLoaded = true;
        }
    });

    it('keeps file browser row plumbing stable when equivalent row actions change identity', async () => {

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

    // Moved from the retired session-only RepositoryTreeList: the live tree owns drop targets and pinning.
    const renderWithDrop = async (props: Record<string, unknown> = {}) => {
        return renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                {...props}
            />,
        );
    };
    const dropTargetOf = (screen: Awaited<ReturnType<typeof renderWithDrop>>, path: string) =>
        screen.findAll((node) => (node.type as any) === 'WebDropTargetView'
            && node.findAll((child) => child.props?.testID === `repository-tree-row-${toTestIdSafeValue(path)}`).length > 0)[0];

    it('describes a file row destination and a closed folder for the common event owner', async () => {
        repositoryTreeBrowserState.nodes = [
            { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
            { path: 'README.md', name: 'README.md', type: 'file', depth: 0, parentDirectoryPath: '' },
        ];
        const screen = await renderWithDrop({ webFileDropEnabled: true });

        expect(dropTargetOf(screen, 'README.md')?.props.repositoryFileDropTarget)
            .toEqual({ destinationDir: '', hoverPath: 'README.md', autoExpandDirectoryPath: null });
        expect(dropTargetOf(screen, 'src')?.props.repositoryFileDropTarget)
            .toEqual({ destinationDir: 'src', hoverPath: 'src', autoExpandDirectoryPath: 'src' });
    });

    it('opens a file on press and pins it on double press', async () => {
        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();
        const screen = await renderWithDrop({ onOpenFile, onOpenFilePinned });
        const readme = screen.findAll((node) => (node.type as any) === 'FilesystemBrowserRow'
            && node.props.testID === `repository-tree-row-${toTestIdSafeValue('README.md')}`)[0];
        await act(async () => {
            readme?.props.onPress();
            readme?.props.onDoublePress();
        });
        expect(onOpenFile).toHaveBeenCalledWith('README.md');
        expect(onOpenFilePinned).toHaveBeenCalledWith('README.md');
    });

    it('on a Code folder page goes into a folder by its name and opens it in place only by its chevron', async () => {
        const toggled: string[] = [];
        toggleDirectorySpy.current = (path) => { toggled.push(path); };
        const onOpenFolder = vi.fn();
        const onOpenFile = vi.fn();
        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                rootDirectoryPath="apps/ui"
                folderPage={{ onOpenFolder }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={onOpenFile}
            />,
        );
        // The folder page lists that folder, not the repository root.
        expect(treeBrowserInputs.current?.rootDirectoryPath).toBe('apps/ui');
        const row = (path: string) => screen.findAll((node) => (node.type as any) === 'FilesystemBrowserRow'
            && node.props.testID === `repository-tree-row-${toTestIdSafeValue(path)}`)[0];
        expect(row('src')?.props.rowPresentation).toBe('table');

        await act(async () => { row('src')?.props.onDisclosurePress(); });
        expect(toggled).toEqual(['src']);
        expect(onOpenFolder).not.toHaveBeenCalled();

        await act(async () => { row('src')?.props.onPress(); });
        expect(onOpenFolder).toHaveBeenCalledWith('src');
        expect(toggled).toEqual(['src']);

        await act(async () => { row('README.md')?.props.onPress(); });
        expect(onOpenFile).toHaveBeenCalledWith('README.md');
        // A file row has no disclosure target of its own.
        expect(row('README.md')?.props.onDisclosurePress).toBeNull();
        toggleDirectorySpy.current = null;
    });

    it('redraws mounted rows when the change badges arrive after the first render', async () => {
        badgeIndexState.current = null;
        function Wrapper() {
            const [, bump] = React.useState(0);
            return (
                <>
                    <WorkspaceRepositoryTreeList
                        theme={theme}
                        scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                        expandedPaths={[]}
                        onExpandedPathsChange={() => {}}
                        onOpenFile={() => {}}
                    />
                    {React.createElement('Pressable' as any, { testID: 'badges-arrive', onPress: () => bump((v) => v + 1) })}
                </>
            );
        }
        const screen = await renderScreen(<Wrapper />);
        const before = latestFilesystemBrowserProps.current?.extraData;
        badgeIndexState.current = { getFileBadge: () => null, getDirectoryBadge: () => null };
        await act(async () => {
            screen.pressByTestId('badges-arrive');
        });
        expect(latestFilesystemBrowserProps.current?.extraData).not.toBe(before);
        badgeIndexState.current = null;
    });

    it('moves the selected mark between rows without redrawing every mounted row', async () => {
        repositoryTreeBrowserState.nodes = [
            { path: 'a.ts', name: 'a.ts', type: 'file', depth: 0 },
            { path: 'b.ts', name: 'b.ts', type: 'file', depth: 0 },
            { path: 'c.ts', name: 'c.ts', type: 'file', depth: 0 },
        ];
        const renders: string[] = [];
        const element = (selectedPath: string) => (
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                selectedPath={selectedPath}
            />
        );
        const screen = await renderScreen(element('a.ts'));
        const before = latestFilesystemBrowserProps.current?.extraData;
        const selectedOf = (path: string) => screen.findAll((node) => (node.type as any) === 'FilesystemBrowserRow'
            && node.props.testID === `repository-tree-row-${toTestIdSafeValue(path)}`)[0]?.props.selected;
        expect(selectedOf('a.ts')).toBe(true);
        await act(async () => { screen.update(element('b.ts')); });
        // Every mounted row reads extraData; a selection change must not republish it.
        expect(latestFilesystemBrowserProps.current?.extraData).toBe(before);
        expect(selectedOf('a.ts')).toBe(false);
        expect(selectedOf('b.ts')).toBe(true);
        expect(selectedOf('c.ts')).toBe(false);
        void renders;
    });

    it('moves the roving tab stop between rows without redrawing every mounted row', async () => {
        repositoryTreeBrowserState.nodes = [
            { path: 'a.ts', name: 'a.ts', type: 'file', depth: 0 },
            { path: 'b.ts', name: 'b.ts', type: 'file', depth: 0 },
            { path: 'c.ts', name: 'c.ts', type: 'file', depth: 0 },
        ];
        const screen = await renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                selectedPath={null}
            />,
        );
        const rowOf = (path: string) => screen.findAll((node) => (node.type as any) === 'FilesystemBrowserRow'
            && node.props.testID === `repository-tree-row-${toTestIdSafeValue(path)}`)[0];
        expect(rowOf('a.ts')?.props.treeItemProps.webTabIndex).toBe(0);
        const before = latestFilesystemBrowserProps.current?.extraData;
        // Clicking a row focuses it, which moves the tree's single tab stop.
        await act(async () => { rowOf('b.ts')?.props.treeItemProps.onFocus(); });
        // Every mounted row reads extraData; a tab-stop move must not republish it.
        expect(latestFilesystemBrowserProps.current?.extraData).toBe(before);
        expect(rowOf('a.ts')?.props.treeItemProps.webTabIndex).toBe(-1);
        expect(rowOf('b.ts')?.props.treeItemProps.webTabIndex).toBe(0);
        expect(rowOf('c.ts')?.props.treeItemProps.webTabIndex).toBe(-1);
    });
});
