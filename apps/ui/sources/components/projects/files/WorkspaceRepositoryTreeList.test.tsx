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
            onPress: props.onPress,
            onDoublePress: props.onDoublePress,
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
});
