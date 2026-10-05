import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

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

// The directory listing is a machine RPC (the one boundary under the tree); the Git tree must not ask for it.
const treeBrowser = vi.hoisted(() => ({ enabledCalls: [] as boolean[] }));
vi.mock('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser', () => ({
    useWorkspaceRepositoryTreeBrowser: (input: { enabled: boolean }) => {
        treeBrowser.enabledCalls.push(input.enabled);
        return {
            rootLoading: false,
            rootError: null,
            nodes: [],
            toggleDirectory: vi.fn(),
            retryRoot: vi.fn(),
            retryDirectory: vi.fn(),
            gitIgnoreAvailable: true,
        };
    },
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

const SNAPSHOT = {
    projectKey: 'p1',
    fetchedAt: 0,
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: { changeSetModel: 'index' },
    branch: { head: 'v0.3', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [
        entry('apps/ui/sources/app/settings.tsx', 'modified'),
        entry('apps/ui/sources/components/settings/modal/SettingsModal.tsx', 'modified'),
        entry('apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts', 'untracked'),
        entry('AGENTS.md', 'modified'),
    ],
    totals: {},
} as any;

const theme = {
    colors: {
        text: { primary: '#111', link: '#09f', secondary: '#aaa', tertiary: '#ccc' },
        surface: { pressed: '#222', base: '#fff', inset: '#eee' },
        state: {
            warning: { foreground: '#b70' },
            neutral: { foreground: '#b70' },
            success: { foreground: '#0a0' },
            danger: { foreground: '#d00' },
        },
    },
} as any;

const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;
const textOf = (node: any): string => (node == null ? '' : typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const checkedOf = (node: any) => node?.props['aria-checked'] ?? node?.props.accessibilityState?.checked;

describe('GitChangesTree', () => {
    async function render(props: Record<string, unknown> = {}) {
        const { GitChangesTree } = await import('./GitChangesTree');
        const handlers = { onToggleFile: vi.fn(), onToggleFolder: vi.fn(), onOpenFile: vi.fn() };
        const screen = await renderScreen(
            <GitChangesTree
                theme={theme}
                sessionId="s1"
                serverId="server"
                machineId="m1"
                snapshot={SNAPSHOT}
                files={selectScmChangedFiles(SNAPSHOT)}
                selectedPaths={new Set<string>()}
                selectionEnabled
                renderTrailingActions={() => null}
                {...handlers}
                {...props}
            />,
        );
        return { screen, handlers };
    }

    it('checks folders from the one folder selector: all of it, some of it, none of it', async () => {
        const { screen } = await render({
            selectedPaths: new Set([
                'apps/ui/sources/components/settings/modal/SettingsModal.tsx',
                'apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts',
            ]),
        });
        // The state each row's checkbox draws (the pressable exposes checked/unchecked only, so `mixed`
        // is read from the row's selection).
        const stateOf = (path: string) => screen.findAll((node) => node.props?.node?.path === path && node.props?.selection !== undefined)[0]?.props.selection.state;
        expect(stateOf('apps/ui/sources/components/settings/modal')).toBe('checked');
        expect(stateOf('apps/ui/sources')).toBe('mixed');
        expect(stateOf('AGENTS.md')).toBe('unchecked');
        expect(checkedOf(screen.findHostByTestId(`${rowId('apps/ui/sources/components/settings/modal')}-select`))).toBe(true);
        // The Git tree never lists the whole folder: it asks no directory listing of the machine.
        expect(treeBrowser.enabledCalls.every((enabled) => enabled === false)).toBe(true);
    });

    it('selects every change beneath a folder, and one file from its own box', async () => {
        const { screen, handlers } = await render({
            selectedPaths: new Set(['apps/ui/sources/app/settings.tsx']),
        });
        await act(async () => {
            screen.pressByTestId(`${rowId('apps/ui/sources')}-select`);
        });
        expect(handlers.onToggleFolder).toHaveBeenCalledWith([
            'apps/ui/sources/app/settings.tsx',
            'apps/ui/sources/components/settings/modal/SettingsModal.tsx',
            'apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts',
        ], true);
        await act(async () => {
            screen.pressByTestId(`${rowId('AGENTS.md')}-select`);
        });
        expect(handlers.onToggleFile).toHaveBeenCalledWith(expect.objectContaining({ fullPath: 'AGENTS.md' }));
    });

    it('puts the Git letter in the icon slot after the checkbox', async () => {
        const { screen } = await render();
        // The row primitive hands its leading slot (disclosure · checkbox · mark) to the list row as `icon`.
        const row = screen.findAll((node) => node.props?.testID === rowId('AGENTS.md') && node.props.leftElement !== undefined && node.props.node === undefined)[0];
        const leading = await renderScreen(<>{row?.props.leftElement}</>);
        expect(textOf(leading.findHostByTestId(`${rowId('AGENTS.md')}-change`))).toBe('M');
    });

    it('shows only the files of the current scope, with folder counts of that scope', async () => {
        const all = selectScmChangedFiles(SNAPSHOT);
        const { screen } = await render({
            files: all.filter((file) => file.fullPath === 'AGENTS.md' || file.fullPath === 'apps/ui/sources/app/settings.tsx'),
        });
        expect(screen.findAllByTestId(rowId('apps/ui/sources/components/settings/modal/SettingsModal.tsx'))).toHaveLength(0);
        expect(screen.findAllByTestId(rowId('AGENTS.md')).length).toBeGreaterThan(0);
        expect(textOf(screen.findHostByTestId(`${rowId('apps/ui/sources/app')}-changes`))).toBe('1');
    });

    it('opens a file through the list owner (Review follows when it is on screen)', async () => {
        const { screen, handlers } = await render();
        await act(async () => {
            screen.pressByTestId(rowId('AGENTS.md'));
        });
        expect(handlers.onOpenFile).toHaveBeenCalledWith('AGENTS.md');
    });

    it('keeps conflicted files out of both row and folder commit selection', async () => {
        const snapshot = { ...SNAPSHOT, hasConflicts: true, entries: [entry('src/a.ts', 'conflicted'), entry('src/b.ts', 'modified')] };
        const { screen, handlers } = await render({ snapshot, files: selectScmChangedFiles(snapshot) });
        expect(screen.findAllByTestId(`${rowId('src/a.ts')}-select`)).toHaveLength(0);
        await screen.pressByTestIdAsync(`${rowId('src')}-select`);
        expect(handlers.onToggleFolder).toHaveBeenCalledWith(['src/b.ts'], true);
    });
});
