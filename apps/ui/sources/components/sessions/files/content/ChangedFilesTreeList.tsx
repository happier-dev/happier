import * as React from 'react';
import { FlatList, Platform, View, type ScrollViewProps } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmWorkingSnapshot, ScmWorkingEntry } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmStatusEntriesWindowState } from '@/scm/entries/scmStatusEntriesWindow';
import { buildChangedFilesOutlineTree, type ChangedFilesOutlineNode } from '@/components/sessions/files/repositoryTree/buildChangedFilesOutlineTree';
import { useScmTreeBadgeIndex } from '@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type ChangedFilesTreeListProps = Readonly<{
    theme: any;
    snapshot: ScmWorkingSnapshot;
    searchQuery: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    /**
     * Bounded entries window state (plan unit 6). When present, rows render
     * from the window (collapsed directory rows + loose files) or from its
     * snapshot fallback instead of the snapshot's entries array.
     */
    entriesWindow?: ScmStatusEntriesWindowState | null;
    onExpandDirectory?: (directoryPath: string) => void;
    onCollapseDirectory?: (directoryPath: string) => void;
    onLoadMoreExpanded?: (directoryPath: string) => void;
    onLoadMoreTopLevel?: () => void;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
}>;

function entryToFileStatus(entry: any): ScmFileStatus {
    const isDirectory = entry.isDirectory === true;
    const displayPath = isDirectory && String(entry.path).endsWith('/') ? String(entry.path).slice(0, -1) : String(entry.path);
    const segments = displayPath.split('/');
    const fileName = segments[segments.length - 1] || displayPath;
    const filePath = segments.slice(0, -1).join('/');
    const preferIncluded = entry.hasIncludedDelta === true && entry.hasPendingDelta !== true;
    return {
        fileName,
        filePath,
        fullPath: entry.path,
        status: entry.kind,
        isIncluded: preferIncluded,
        hasIncludedDelta: entry.hasIncludedDelta,
        linesAdded: preferIncluded ? (entry.stats?.includedAdded ?? 0) : (entry.stats?.pendingAdded ?? 0),
        linesRemoved: preferIncluded ? (entry.stats?.includedRemoved ?? 0) : (entry.stats?.pendingRemoved ?? 0),
        oldPath: entry.previousPath ?? undefined,
        isBinary: entry.stats?.isBinary ?? undefined,
        isComplete: entry.stats?.isComplete,
        ...(isDirectory ? { isDirectory: true } : {}),
        ...(entry.untrackedFileCount === undefined ? {} : { untrackedFileCount: entry.untrackedFileCount }),
    };
}

type CollapsedDirectoryInfo = Readonly<{
    entryPath: string;
    untrackedFileCount?: number;
}>;

type FlattenedNode =
    | (ChangedFilesOutlineNode & { kind: 'dir'; depth: number; collapsedDirectory?: CollapsedDirectoryInfo })
    | (ChangedFilesOutlineNode & { kind: 'file'; depth: number })
    | { kind: 'loadMore'; directoryPath: string; depth: number }
    | { kind: 'loadMoreTopLevel'; depth: number };

function mergeCollapsedDirectoryEntries(
    nodes: ChangedFilesOutlineNode[],
    directoryEntries: readonly ScmWorkingEntry[]
): ChangedFilesOutlineNode[] {
    const merged = [...nodes];
    for (const entry of directoryEntries) {
        const displayPath = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
        const parts = displayPath.split('/').filter(Boolean);
        if (parts.length === 0) continue;

        let level = merged;
        let fullPath = '';
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index]!;
            fullPath = fullPath ? `${fullPath}/${part}` : part;
            const isLeaf = index === parts.length - 1;
            let node = level.find((candidate) => candidate.kind === 'dir' && candidate.name === part && candidate.fullPath === fullPath) as
                | (ChangedFilesOutlineNode & { kind: 'dir' })
                | undefined;
            if (!node) {
                node = { kind: 'dir', name: part, fullPath, children: [] };
                level.push(node);
            }
            if (isLeaf) {
                (node as ChangedFilesOutlineNode & { kind: 'dir'; collapsedDirectory?: CollapsedDirectoryInfo }).collapsedDirectory = {
                    entryPath: entry.path,
                    ...(entry.untrackedFileCount === undefined ? {} : { untrackedFileCount: entry.untrackedFileCount }),
                };
            }
            level = node.children;
        }
    }
    return merged;
}

function flattenTree(
    nodes: ChangedFilesOutlineNode[],
    depth: number,
    expanded: ReadonlySet<string>,
    expansions: ReadonlyMap<string, { entries: readonly ScmWorkingEntry[]; hasMore: boolean }> | null
): FlattenedNode[] {
    const out: FlattenedNode[] = [];
    for (const node of nodes) {
        if (node.kind === 'file') {
            out.push({ ...node, depth });
            continue;
        }
        const collapsed = (node as ChangedFilesOutlineNode & { kind: 'dir'; collapsedDirectory?: CollapsedDirectoryInfo }).collapsedDirectory;
        out.push({ ...node, depth, ...(collapsed ? { collapsedDirectory: collapsed } : {}) });
        const isExpanded = expanded.has(node.fullPath) || (collapsed !== undefined && expansions?.has(collapsed.entryPath));
        if (!isExpanded) continue;

        const collapsedEntryPath = collapsed?.entryPath;
        if (collapsedEntryPath !== undefined && expansions) {
            const expansion = expansions.get(collapsedEntryPath);
            if (expansion) {
                for (const entry of expansion.entries) {
                    const file = entryToFileStatus(entry);
                    const segments = file.fullPath.split('/');
                    out.push({
                        kind: 'file',
                        name: segments[segments.length - 1] || file.fullPath,
                        fullPath: file.fullPath,
                        file,
                        depth: depth + 1,
                    });
                }
                if (expansion.hasMore) {
                    out.push({ kind: 'loadMore', directoryPath: collapsedEntryPath, depth: depth + 1 });
                }
            }
        } else {
            out.push(...flattenTree(node.children, depth + 1, expanded, expansions));
        }
    }
    return out;
}

/**
 * The one owner of "which rows does the changed-files surface render": the
 * demand-loaded entries window when it holds rows, its snapshot fallback, or
 * the snapshot's own entries for a complete (legacy/fallback) delivery.
 * Consumers that need to reason about the row set (e.g. whether collapsed
 * directory rows are present) must ask this function rather than re-deriving
 * the precedence.
 */
export function resolveChangedFilesRowSource(input: {
    entriesWindow?: ScmStatusEntriesWindowState | null;
    snapshot: ScmWorkingSnapshot | null | undefined;
}): readonly ScmWorkingEntry[] {
    if (input.entriesWindow?.mode === 'window') return input.entriesWindow.entries ?? [];
    if (input.entriesWindow?.mode === 'snapshot-fallback') return input.entriesWindow.fallbackEntries ?? [];
    return input.snapshot?.entries ?? [];
}

/**
 * Search candidate set: every row the surface knows, independent of expansion state —
 * structural children of closed directories and loaded collapsed-directory expansions
 * included. The visible tree (flattenTree) stays expansion-dependent; search must not be.
 */
function collectAllRows(
    nodes: ChangedFilesOutlineNode[],
    depth: number,
    expansions: ReadonlyMap<string, { entries: readonly ScmWorkingEntry[]; hasMore: boolean }> | null,
): FlattenedNode[] {
    const out: FlattenedNode[] = [];
    for (const node of nodes) {
        if (node.kind === 'file') {
            out.push({ ...node, depth });
            continue;
        }
        const collapsed = (node as ChangedFilesOutlineNode & { kind: 'dir'; collapsedDirectory?: CollapsedDirectoryInfo }).collapsedDirectory;
        out.push({ ...node, depth, ...(collapsed ? { collapsedDirectory: collapsed } : {}) });
        out.push(...collectAllRows(node.children, depth + 1, expansions));
        const collapsedEntryPath = collapsed?.entryPath;
        if (collapsedEntryPath !== undefined && expansions) {
            const expansion = expansions.get(collapsedEntryPath);
            if (expansion) {
                for (const entry of expansion.entries) {
                    const file = entryToFileStatus(entry);
                    const segments = file.fullPath.split('/');
                    out.push({
                        kind: 'file',
                        name: segments[segments.length - 1] || file.fullPath,
                        fullPath: file.fullPath,
                        file,
                        depth: depth + 1,
                    });
                }
            }
        }
    }
    return out;
}

export const ChangedFilesTreeList = React.memo((props: ChangedFilesTreeListProps) => {
    const sourceEntries = resolveChangedFilesRowSource({
        entriesWindow: props.entriesWindow ?? null,
        snapshot: props.snapshot,
    });

    const changedFiles = React.useMemo(() => {
        return sourceEntries
            .filter((entry) => entry.isDirectory !== true)
            .map(entryToFileStatus);
    }, [sourceEntries]);

    const directoryEntries = React.useMemo(() => {
        return sourceEntries.filter((entry) => entry.isDirectory === true);
    }, [sourceEntries]);

    const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set());

    const tree = React.useMemo(
        () => mergeCollapsedDirectoryEntries(buildChangedFilesOutlineTree(changedFiles), directoryEntries),
        [changedFiles, directoryEntries]
    );
    const badgeIndex = useScmTreeBadgeIndex(props.snapshot);

    const filteredQuery = props.searchQuery.trim().toLowerCase();

    const expansions = props.entriesWindow?.expansions ?? null;

    const toggleDir = React.useCallback((fullPath: string, collapsed?: CollapsedDirectoryInfo) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(fullPath)) {
                next.delete(fullPath);
                if (collapsed) props.onCollapseDirectory?.(collapsed.entryPath);
            } else {
                next.add(fullPath);
                if (collapsed) props.onExpandDirectory?.(collapsed.entryPath);
            }
            return next;
        });
    }, [props.onCollapseDirectory, props.onExpandDirectory]);

    const nodesToRender: FlattenedNode[] = React.useMemo(() => {
        if (!filteredQuery) {
            const flattened = flattenTree(tree, 0, expandedDirs, expansions);
            // A truncated entries window still has more top-level rows on the machine: surface
            // the continuation affordance at the end of the list.
            if (props.entriesWindow?.mode === 'window' && props.entriesWindow.truncated) {
                flattened.push({ kind: 'loadMoreTopLevel', depth: 0 });
            }
            return flattened;
        }
        // Search spans every row the surface knows regardless of expansion state (see
        // collectAllRows); synthetic load-more rows carry no path and never match. Results
        // render flat (depth 0) — the tree hierarchy is not visible in search mode.
        return collectAllRows(tree, 0, expansions)
            .filter((node) => ('fullPath' in node ? node.fullPath.toLowerCase().includes(filteredQuery) : false))
            .map((node) => ({ ...node, depth: 0 }))
            .sort((a, b) => (('fullPath' in a ? a.fullPath : '')).localeCompare(('fullPath' in b ? b.fullPath : ''), undefined, { sensitivity: 'base' }));
    }, [expandedDirs, expansions, filteredQuery, props.entriesWindow, tree]);

    return (
        <FlatList
            data={nodesToRender}
            keyExtractor={(node) => (node.kind === 'loadMore'
                ? `loadMore:${node.directoryPath}`
                : node.kind === 'loadMoreTopLevel'
                    ? 'loadMore:__top__'
                    : `${node.kind}:${node.fullPath}`)}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            renderItem={({ item: node, index }) => {
                const indent = Math.min(6, Math.max(0, node.depth));
                const paddingLeft = 12 + indent * 12;
                const showDivider = index < nodesToRender.length - 1;

                if (node.kind === 'dir') {
                    const collapsed = node.collapsedDirectory;
                    const badge = badgeIndex?.getDirectoryBadge(node.fullPath) ?? null;
                    const countLabel = collapsed?.untrackedFileCount !== undefined
                        ? t('files.changedFilesDirectoryFileCount', { count: collapsed.untrackedFileCount })
                        : null;
                    const rightElement = countLabel ? (
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: props.theme.colors.state.neutral.foreground, ...Typography.monoMeta('semiBold') }}>
                                {countLabel}
                            </Text>
                        </View>
                    ) : badge ? (
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: props.theme.colors.state.neutral.foreground, ...Typography.monoMeta('semiBold') }}>
                                {`${badge.kindLetter}${badge.changedCount}`}
                            </Text>
                            {badge.isComplete !== false && badge.added > 0 ? (
                                <Text style={{ color: props.theme.colors.state.success.foreground, ...Typography.monoMeta('semiBold') }}>
                                    {`+${badge.added}`}
                                </Text>
                            ) : null}
                            {badge.isComplete !== false && badge.removed > 0 ? (
                                <Text
                                    style={{
                                        fontSize: 12,
                                        color: props.theme.colors.state.danger.foreground ?? props.theme.colors.state.neutral.foreground,
                                        ...Typography.mono('semiBold'),
                                    }}
                                >
                                    {`-${badge.removed}`}
                                </Text>
                            ) : null}
                        </View>
                    ) : undefined;

                    const isExpanded = expandedDirs.has(node.fullPath);
                    return (
                        <Item
                            title={`${node.name}/`}
                            icon={<Icon name={isExpanded ? 'folder-open' : 'folder'} size={16} color={props.theme.colors.text.link} />}
                            density="tight"
                            rightElement={rightElement}
                            showChevron={false}
                            onPress={() => toggleDir(node.fullPath, collapsed)}
                            showDivider={showDivider}
                            style={{
                                paddingLeft,
                                paddingRight: 8,
                            }}
                        />
                    );
                }

                if (node.kind === 'loadMoreTopLevel') {
                    return (
                        <Item
                            title={t('files.changedFilesLoadMore')}
                            density="tight"
                            showChevron={false}
                            onPress={() => props.onLoadMoreTopLevel?.()}
                            showDivider={showDivider}
                            style={{
                                paddingLeft,
                                paddingRight: 8,
                            }}
                        />
                    );
                }

                if (node.kind === 'loadMore') {
                    return (
                        <Item
                            title={t('files.changedFilesLoadMore')}
                            density="tight"
                            showChevron={false}
                            onPress={() => props.onLoadMoreExpanded?.(node.directoryPath)}
                            showDivider={showDivider}
                            style={{
                                paddingLeft,
                                paddingRight: 8,
                            }}
                        />
                    );
                }

                const resolved = badgeIndex?.getFileBadge(node.fullPath) ?? null;
                const rightElement = resolved ? (
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        <Text style={{ fontSize: 12, color: props.theme.colors.state.neutral.foreground, ...Typography.mono('semiBold') }}>
                            {resolved.kindLetter}
                        </Text>
                        {resolved.isComplete !== false && resolved.added > 0 ? (
                            <Text style={{ fontSize: 12, color: props.theme.colors.state.success.foreground, ...Typography.mono('semiBold') }}>
                                {`+${resolved.added}`}
                            </Text>
                        ) : null}
                        {resolved.isComplete !== false && resolved.removed > 0 ? (
                            <Text
                                style={{
                                    fontSize: 12,
                                    color: props.theme.colors.state.danger.foreground ?? props.theme.colors.state.neutral.foreground,
                                    ...Typography.mono('semiBold'),
                                }}
                            >
                                {`-${resolved.removed}`}
                            </Text>
                        ) : null}
                    </View>
                ) : undefined;

                return (
                    <Item
                        title={node.name}
                        icon={<FileIcon fileName={node.name} size={16} />}
                        density="tight"
                        rightElement={rightElement}
                        showChevron={false}
                        onPress={() => props.onOpenFile(node.fullPath)}
                        onDoublePress={() => (props.onOpenFilePinned ?? props.onOpenFile)(node.fullPath)}
                        showDivider={showDivider}
                        style={{
                            paddingLeft,
                            paddingRight: 8,
                        }}
                    />
                );
            }}
            initialNumToRender={Math.min(32, nodesToRender.length)}
            maxToRenderPerBatch={32}
            windowSize={7}
            removeClippedSubviews={Platform.OS !== 'web'}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
            scrollEventThrottle={props.scrollEventThrottle ?? 16}
            getItemLayout={
                Platform.OS === 'web'
                    ? (_data, index) => {
                        const length = 38;
                        return { length, offset: length * index, index };
                    }
                    : undefined
            }
        />
    );
});
