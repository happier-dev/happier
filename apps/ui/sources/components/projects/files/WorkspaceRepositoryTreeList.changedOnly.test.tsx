import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (value: Record<string, unknown>) => value.ios ?? value.default,
        },
    });
});

const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);

// The directory listing is a machine RPC: the one boundary this tree reads through.
const lazyTree = vi.hoisted(() => ({
    nodes: [
        { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
        { path: 'README.md', name: 'README.md', type: 'file', depth: 0, isExpanded: false, isLoadingChildren: false },
    ] as any[],
}));
vi.mock('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser', () => ({
    useWorkspaceRepositoryTreeBrowser: () => ({
        rootLoading: false,
        rootError: null,
        nodes: lazyTree.nodes,
        toggleDirectory: vi.fn(),
        retryRoot: vi.fn(),
        retryDirectory: vi.fn(),
        gitIgnoreAvailable: true,
    }),
}));

// Virtualization is a platform list; render every row so the test reads the tree itself.
vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowserList', () => ({
    FilesystemBrowserList: (props: any) => React.createElement(
        'View',
        { testID: 'tree' },
        ...(props.nodes ?? []).map((node: any, index: number) => React.createElement(
            React.Fragment,
            { key: node.path },
            props.renderRow({ node, showDivider: index < props.nodes.length - 1 }),
        )),
    ),
}));

function entry(path: string, kind: string) {
    return {
        path,
        previousPath: null,
        kind,
        includeStatus: '',
        pendingStatus: '',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 3, pendingRemoved: 1, isBinary: false },
    };
}

function snapshot(entries: any[]) {
    return {
        projectKey: 'p1',
        fetchedAt: 0,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: { changeSetModel: 'index' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries,
        totals: {},
    } as any;
}

const CHANGED = snapshot([
    entry('apps/ui/sources/app/settings.tsx', 'modified'),
    entry('apps/ui/sources/components/settings/modal/SettingsModal.tsx', 'modified'),
    entry('apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts', 'untracked'),
    entry('scratch/', 'untracked'),
    entry('AGENTS.md', 'modified'),
]);

const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;
const textOf = (node: any): string => (node == null ? '' : typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));

describe('WorkspaceRepositoryTreeList · Changed only', () => {
    const theme = {
        colors: {
            text: { primary: '#111', link: '#09f', secondary: '#aaa' },
            surface: { pressed: '#222', base: '#fff' },
            state: {
                neutral: { foreground: '#b70' },
                success: { foreground: '#0a0' },
                danger: { foreground: '#d00' },
                active: { foreground: '#07f', background: '#eef' },
            },
        },
    } as any;

    beforeEach(() => {
        lazyTree.nodes = [
            { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false },
            { path: 'README.md', name: 'README.md', type: 'file', depth: 0, isExpanded: false, isLoadingChildren: false },
        ];
    });

    async function render(props: Partial<React.ComponentProps<typeof import('./WorkspaceRepositoryTreeList').WorkspaceRepositoryTreeList>> = {}) {
        const { WorkspaceRepositoryTreeList } = await import('./WorkspaceRepositoryTreeList');
        return renderScreen(
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                expandedPaths={[]}
                onExpandedPathsChange={() => {}}
                onOpenFile={() => {}}
                scmSnapshot={CHANGED}
                changedOnly
                {...props}
            />,
        );
    }

    it('prunes the tree in place to the changed files, with their folders open and single-child chains as one row', async () => {
        const screen = await render();

        // One entry per tree row: the row owner is the element that carries the tree node.
        const titles = screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('repository-tree-row-')
            && node.props.node !== undefined
            && typeof node.props.title === 'string')
            .map((node) => node.props.title);
        expect(titles).toEqual([
            'apps/ui/sources',
            'app',
            'settings.tsx',
            'components/settings/modal',
            'SettingsModal.tsx',
            'useSettingsRouteKey.ts',
            'AGENTS.md',
        ]);
        // The rows the directory listing produced are not part of the footprint.
        expect(screen.findAllByTestId(rowId('README.md'))).toHaveLength(0);
        // Folder counts come from the same list as the header count.
        expect(selectScmChangedFiles(CHANGED)).toHaveLength(4);
        expect(textOf(screen.findHostByTestId(`${rowId('apps/ui/sources')}-changes`))).toBe('3');
    });

    it('renders permanent file metadata before any hover or action-menu interaction', async () => {
        const screen = await render({ renderRowMetadata: (node) => node.type === 'file'
            ? React.createElement('Text', { testID: `find-count:${node.path}` }, '3') : null });
        expect(textOf(screen.findHostByTestId('find-count:AGENTS.md'))).toBe('3');
        const row = screen.findAll((node) => node.props.testID === rowId('AGENTS.md') && node.props.node !== undefined)[0];
        expect(row.props.rowActions).toBeNull();
    });

    it('closes and reopens a folder of the footprint', async () => {
        const screen = await render();
        await act(async () => {
            screen.pressByTestId(rowId('apps/ui/sources/components/settings/modal'));
        });
        expect(screen.findAllByTestId(rowId('apps/ui/sources/components/settings/modal/SettingsModal.tsx'))).toHaveLength(0);
        expect(screen.findAllByTestId(rowId('AGENTS.md')).length).toBeGreaterThan(0);

        await act(async () => {
            screen.pressByTestId(rowId('apps/ui/sources/components/settings/modal'));
        });
        expect(screen.findAllByTestId(rowId('apps/ui/sources/components/settings/modal/SettingsModal.tsx')).length).toBeGreaterThan(0);
    });

    it('marks files with the Git letter and keeps the open file selected', async () => {
        const screen = await render({ selectedPath: 'AGENTS.md' });
        expect(textOf(screen.findHostByTestId(`${rowId('apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts')}-change`))).toBe('A');
        expect(textOf(screen.findHostByTestId(`${rowId('AGENTS.md')}-change`))).toBe('M');
        const selected = screen.findAll((node) => node.props?.testID === rowId('AGENTS.md') && node.props.selected === true);
        expect(selected.length).toBeGreaterThan(0);
    });

    it('lights up a selected commit proposal\'s files with their part, and leaves the checkboxes meaning staging', async () => {
        const checked = new Set(['AGENTS.md']);
        const screen = await render({
            rowSelection: { revision: 1, getState: (node) => (checked.has(node.path) ? 'checked' : 'unchecked'), onToggle: vi.fn(), accessibilityLabel: (node) => node.name },
            rowProposal: { revision: 'p1', paths: new Set(['apps/ui/sources/components/settings/modal/SettingsModal.tsx']),
                notes: new Map([['apps/ui/sources/components/settings/modal/SettingsModal.tsx', '1 of 2 changes']]) },
        });
        expect(textOf(screen.findHostByTestId(`${rowId('apps/ui/sources/components/settings/modal/SettingsModal.tsx')}-proposal-note`))).toBe('1 of 2 changes');
        expect(screen.findAllByTestId(`${rowId('AGENTS.md')}-proposal-note`)).toHaveLength(0);
        const agents = screen.findHostByTestId(`${rowId('AGENTS.md')}-select`);
        expect(agents?.props['aria-checked'] ?? agents?.props.accessibilityState?.checked).toBe(true);
    });

    it('says nothing has changed and offers every file back when the list is empty', async () => {
        const onShowAllFiles = vi.fn();
        const screen = await render({ scmSnapshot: snapshot([]), onShowAllFiles });
        const state = screen.findAll((node) => node.props?.testID === 'repository-tree-changed-only-empty' && node.props.title !== undefined)[0];
        expect(state?.props.title).toBe('files.pane.noChangedFilesTitle');
        await act(async () => {
            state?.props.action.onPress();
        });
        expect(onShowAllFiles).toHaveBeenCalledTimes(1);
    });

    it('draws a controlled checkbox in place of the entry icon and keeps trailing row actions (the Git tree reuse)', async () => {
        const checked = new Set(['AGENTS.md']);
        const onToggle = vi.fn();
        const screen = await render({
            rowSelection: {
                revision: 1,
                getState: (node) => (checked.has(node.path) ? 'checked' : 'unchecked'),
                onToggle,
                accessibilityLabel: (node) => `select ${node.name}`,
            },
            renderRowActions: (node) => React.createElement('View', { testID: `row-action:${node.path}` }),
        });

        const agents = screen.findHostByTestId(`${rowId('AGENTS.md')}-select`);
        expect(agents?.props['aria-checked'] ?? agents?.props.accessibilityState?.checked).toBe(true);
        // Trailing actions come through the row's reveal (native: a long press opens them).
        expect(screen.findAllByTestId('row-action:AGENTS.md')).toHaveLength(0);
        await act(async () => {
            screen.findAll((node) => node.props?.testID === rowId('AGENTS.md') && typeof node.props?.onLongPress === 'function')[0]?.props.onLongPress();
        });
        expect(screen.findAllByTestId('row-action:AGENTS.md').length).toBeGreaterThan(0);
        await act(async () => {
            screen.pressByTestId(`${rowId('AGENTS.md')}-select`);
        });
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ path: 'AGENTS.md', type: 'file' }));
        // Folders carry the checkbox too (the consumer decides mixed/checked from its own selection).
        expect(screen.findAllByTestId(`${rowId('apps/ui/sources')}-select`).length).toBeGreaterThan(0);
    });
});
