import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import {
    installFilesContentCommonModuleMocks,
} from './filesContentTestHelpers';
import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmStatusEntriesWindowState } from '@/scm/entries/scmStatusEntriesWindow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const itemPropsByTestID: Array<Record<string, any>> = [];

// FlatList mock that actually maps data through renderItem so row assertions work.
installFilesContentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => `${key}(${String(params?.count ?? '')})`,
        });
    },
    reactNative: async () => {
        const React = (await import('react')).default ?? (await import('react'));
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            FlatList: ({ data, renderItem, keyExtractor }: any) =>
                React.createElement('FlatList', null, (data ?? []).map((item: any, index: number) =>
                    React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? index }, renderItem({ item, index })))),
            Platform: {
                select: (value: any) => value?.default ?? null,
                OS: 'web',
            },
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemPropsByTestID.push(props);
        return React.createElement('Item', props, props.title, props.rightElement);
    },
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: 'Icon',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', async (importOriginal) => {
    return await importOriginal();
});

vi.mock('@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex', () => ({
    useScmTreeBadgeIndex: () => null,
}));

function makeSnapshotEntry(path: string, overrides?: Record<string, unknown>): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind: 'untracked',
        includeStatus: '?',
        pendingStatus: '?',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            isBinary: false,
        },
        ...overrides,
    };
}

function makeSnapshot(entries: any[]): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 100,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: entries.length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            changedFiles: 30000,
        },
    } as unknown as ScmWorkingSnapshot;
}

function makeWindowState(partial: Partial<ScmStatusEntriesWindowState>): ScmStatusEntriesWindowState {
    return {
        mode: 'window',
        status: 'ready',
        entries: [],
        fallbackEntries: null,
        expansions: new Map(),
        truncated: false,
        ...partial,
    };
}

async function renderTreeList(props: {
    snapshot: ScmWorkingSnapshot;
    searchQuery?: string;
    entriesWindow?: ScmStatusEntriesWindowState | null;
    onExpandDirectory?: (path: string) => void;
    onCollapseDirectory?: (path: string) => void;
    onLoadMoreExpanded?: (path: string) => void;
    onLoadMoreTopLevel?: () => void;
    onOpenFile?: (path: string) => void;
}) {
    const { ChangedFilesTreeList } = await import('./ChangedFilesTreeList');
    return await renderScreen(<ChangedFilesTreeList
        theme={createThemeFixture() as any}
        snapshot={props.snapshot}
        searchQuery={props.searchQuery ?? ""}
        onOpenFile={props.onOpenFile ?? vi.fn()}
        entriesWindow={props.entriesWindow ?? null}
        onExpandDirectory={props.onExpandDirectory}
        onCollapseDirectory={props.onCollapseDirectory}
        onLoadMoreExpanded={props.onLoadMoreExpanded}
        onLoadMoreTopLevel={props.onLoadMoreTopLevel}
    />);
}

describe('ChangedFilesTreeList with the bounded entries window', () => {
    it('finds collapsed directory rows and loaded expansion children by search query', async () => {
        itemPropsByTestID.length = 0;
        const snapshot = makeSnapshot([
            makeSnapshotEntry('guides/', { isDirectory: true, untrackedFileCount: 2 }),
            makeSnapshotEntry('standalone.ts'),
        ]);
        const expansions = new Map([
            ['guides/', {
                directoryPath: 'guides/',
                entries: [makeSnapshotEntry('guides/nested-guide.ts')],
                loading: false,
                hasMore: false,
            } as const],
        ]);
        const entriesWindow = makeWindowState({
            entries: [
                makeSnapshotEntry('guides/', { isDirectory: true, untrackedFileCount: 2 }),
                makeSnapshotEntry('standalone.ts'),
            ],
            expansions,
        });

        // The directory row itself is findable even while collapsed...
        await renderTreeList({ snapshot, entriesWindow, searchQuery: 'guides' });
        expect(itemPropsByTestID.some((props) => props.title === 'guides/')).toBe(true);
        itemPropsByTestID.length = 0;

        // ...and loaded expansion children are findable by the file name.
        const screen = await renderTreeList({ snapshot, entriesWindow, searchQuery: 'nested-guide' });
        expect(screen.getTextContent()).toContain('nested-guide.ts');
    });

    it('finds files inside closed structural directories by search query', async () => {
        itemPropsByTestID.length = 0;
        const snapshot = makeSnapshot([
            makeSnapshotEntry('src/a.ts'),
            makeSnapshotEntry('src/deep/b.ts'),
            makeSnapshotEntry('top.ts'),
        ]);
        const entriesWindow = makeWindowState({
            entries: [
                makeSnapshotEntry('src/a.ts'),
                makeSnapshotEntry('src/deep/b.ts'),
                makeSnapshotEntry('top.ts'),
            ],
        });

        // No expansions, no expandedDirs: src/ is closed in the visible tree.
        const screen = await renderTreeList({ snapshot, entriesWindow, searchQuery: 'b.ts' });
        expect(screen.getTextContent()).toContain('b.ts');
    });

    it('renders a collapsed directory row as "D/" with its untracked file count and expands instead of opening', async () => {
        itemPropsByTestID.length = 0;
        const onOpenFile = vi.fn();
        const onExpandDirectory = vi.fn();
        const snapshot = makeSnapshot([makeSnapshotEntry('D/', { isDirectory: true, untrackedFileCount: 30000 })]);
        const entriesWindow = makeWindowState({
            entries: [makeSnapshotEntry('D/', { isDirectory: true, untrackedFileCount: 30000 })],
        });

        const screen = await renderTreeList({ snapshot, entriesWindow, onExpandDirectory, onOpenFile });

        expect(screen.getTextContent()).toContain('30000');
        const dirRows = itemPropsByTestID.filter((props) => props.title === 'D/');
        expect(dirRows).toHaveLength(1);
        dirRows[0].onPress?.();
        expect(onExpandDirectory).toHaveBeenCalledWith('D/');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('surfaces a top-level load-more row when the entries window is truncated', async () => {
        itemPropsByTestID.length = 0;
        const onLoadMoreTopLevel = vi.fn();
        const snapshot = makeSnapshot([makeSnapshotEntry('a.ts')]);
        const entriesWindow = makeWindowState({
            entries: [makeSnapshotEntry('a.ts')],
            truncated: true,
        });

        await renderTreeList({ snapshot, entriesWindow, onLoadMoreTopLevel });

        const loadMoreRow = itemPropsByTestID.find((props) => props.onPress === undefined ? false : props.title === 'files.changedFilesLoadMore()');
        expect(loadMoreRow).toBeDefined();
        loadMoreRow!.onPress?.();
        expect(onLoadMoreTopLevel).toHaveBeenCalledTimes(1);
    });

    it('renders expanded directory children as real file rows with their per-file actions', async () => {
        itemPropsByTestID.length = 0;
        const onOpenFile = vi.fn();
        const snapshot = makeSnapshot([makeSnapshotEntry('D/', { isDirectory: true, untrackedFileCount: 2 })]);
        const expansions = new Map([
            ['D/', {
                directoryPath: 'D/',
                entries: [
                    makeSnapshotEntry('D/a.ts'),
                    makeSnapshotEntry('D/b.ts'),
                ],
                loading: false,
                hasMore: false,
            } as const],
        ]);
        const entriesWindow = makeWindowState({
            entries: [makeSnapshotEntry('D/', { isDirectory: true, untrackedFileCount: 2 })],
            expansions,
        });

        await renderTreeList({ snapshot, entriesWindow, onOpenFile });

        const fileRows = itemPropsByTestID.filter((props) => props.title === 'a.ts' || props.title === 'b.ts');
        expect(fileRows).toHaveLength(2);
        const rowA = itemPropsByTestID.find((props) => props.title === 'a.ts');
        rowA?.onPress?.();
        expect(onOpenFile).toHaveBeenCalledWith('D/a.ts');
    });

    it('renders the snapshot fallback entries as plain file rows (T5: today\'s UX, no dead end)', async () => {
        itemPropsByTestID.length = 0;
        const onOpenFile = vi.fn();
        const snapshot = makeSnapshot([]);
        const entriesWindow = makeWindowState({
            mode: 'snapshot-fallback',
            fallbackEntries: [
                makeSnapshotEntry('D/a.ts'),
                makeSnapshotEntry('D/b.ts'),
            ],
        });

        await renderTreeList({ snapshot, entriesWindow, onOpenFile });

        // Today's UX: structural directories start collapsed; expanding 'D/' reveals the per-file rows.
        const dirRow = itemPropsByTestID.find((props) => props.title === 'D/');
        expect(dirRow).toBeDefined();
        act(() => dirRow?.onPress?.());
        await Promise.resolve();

        expect(itemPropsByTestID.filter((props) => props.title === 'a.ts')).toHaveLength(1);
        const row = itemPropsByTestID.find((props) => props.title === 'b.ts');
        row?.onPress?.();
        expect(onOpenFile).toHaveBeenCalledWith('D/b.ts');
    });

    it('keeps rendering complete snapshot entries when no window is active', async () => {
        itemPropsByTestID.length = 0;
        const snapshot = makeSnapshot([
            makeSnapshotEntry('src/a.ts', { kind: 'modified', hasPendingDelta: true }),
        ]);

        const screen = await renderTreeList({ snapshot, entriesWindow: null });

        const dirRow = itemPropsByTestID.find((props) => props.title === 'src/');
        expect(dirRow).toBeDefined();
        act(() => dirRow?.onPress?.());
        await Promise.resolve();

        expect(itemPropsByTestID.some((props) => props.title === 'a.ts')).toBe(true);
        expect(screen.getTextContent()).toContain('a.ts');
    });
});
