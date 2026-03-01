import * as React from 'react';
import { FlatList, Platform, View, type ScrollViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { buildChangedFilesOutlineTree, type ChangedFilesOutlineNode } from '@/components/sessions/files/repositoryTree/buildChangedFilesOutlineTree';
import { useScmTreeBadgeIndex } from '@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex';

export type ChangedFilesTreeListProps = Readonly<{
    theme: any;
    snapshot: ScmWorkingSnapshot;
    searchQuery: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
}>;

function entryToFileStatus(entry: any): ScmFileStatus {
    const segments = String(entry.path ?? '').split('/');
    const fileName = segments[segments.length - 1] || String(entry.path ?? '');
    const filePath = segments.slice(0, -1).join('/');
    const preferIncluded = entry.hasIncludedDelta === true && entry.hasPendingDelta !== true;
    return {
        fileName,
        filePath,
        fullPath: entry.path,
        status: entry.kind,
        isIncluded: preferIncluded,
        linesAdded: preferIncluded ? (entry.stats?.includedAdded ?? 0) : (entry.stats?.pendingAdded ?? 0),
        linesRemoved: preferIncluded ? (entry.stats?.includedRemoved ?? 0) : (entry.stats?.pendingRemoved ?? 0),
        oldPath: entry.previousPath ?? undefined,
        isBinary: entry.stats?.isBinary ?? undefined,
    };
}

type FlattenedNode =
    | (ChangedFilesOutlineNode & { kind: 'dir'; depth: number })
    | (ChangedFilesOutlineNode & { kind: 'file'; depth: number });

function flattenTree(nodes: ChangedFilesOutlineNode[], depth: number, expanded: ReadonlySet<string>): FlattenedNode[] {
    const out: FlattenedNode[] = [];
    for (const node of nodes) {
        if (node.kind === 'file') {
            out.push({ ...node, depth });
            continue;
        }
        out.push({ ...node, depth });
        if (expanded.has(node.fullPath)) {
            out.push(...flattenTree(node.children, depth + 1, expanded));
        }
    }
    return out;
}

export const ChangedFilesTreeList = React.memo((props: ChangedFilesTreeListProps) => {
    const changedFiles = React.useMemo(() => {
        return (props.snapshot.entries ?? []).map(entryToFileStatus);
    }, [props.snapshot.entries]);

    const tree = React.useMemo(() => buildChangedFilesOutlineTree(changedFiles), [changedFiles]);
    const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set());
    const badgeIndex = useScmTreeBadgeIndex(props.snapshot);

    const filteredQuery = props.searchQuery.trim().toLowerCase();
    const filteredNodes = React.useMemo(() => {
        if (!filteredQuery) return null;
        const matches = changedFiles
            .filter((f) => f.fullPath.toLowerCase().includes(filteredQuery))
            .sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { sensitivity: 'base' }));
        return matches;
    }, [changedFiles, filteredQuery]);

    const toggleDir = React.useCallback((fullPath: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(fullPath)) next.delete(fullPath);
            else next.add(fullPath);
            return next;
        });
    }, []);

    const nodesToRender: FlattenedNode[] = React.useMemo(() => {
        if (filteredNodes) {
            return filteredNodes.map((file) => ({
                kind: 'file' as const,
                name: file.fileName,
                fullPath: file.fullPath,
                file,
                depth: 0,
            }));
        }
        return flattenTree(tree, 0, expandedDirs);
    }, [expandedDirs, filteredNodes, tree]);

    return (
        <FlatList
            data={nodesToRender}
            keyExtractor={(node) => `${node.kind}:${node.fullPath}`}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            renderItem={({ item: node, index }) => {
                const indent = Math.min(6, Math.max(0, node.depth));
                const paddingLeft = 12 + indent * 12;
                const showDivider = index < nodesToRender.length - 1;

                if (node.kind === 'dir') {
                    const badge = badgeIndex?.getDirectoryBadge(node.fullPath) ?? null;
                    const rightElement = badge ? (
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ fontSize: 12, color: props.theme.colors.warning, ...Typography.mono('semiBold') }}>
                                {`${badge.kindLetter}${badge.changedCount}`}
                            </Text>
                            {badge.added > 0 ? (
                                <Text style={{ fontSize: 12, color: props.theme.colors.success, ...Typography.mono('semiBold') }}>
                                    {`+${badge.added}`}
                                </Text>
                            ) : null}
                            {badge.removed > 0 ? (
                                <Text
                                    style={{
                                        fontSize: 12,
                                        color: props.theme.colors.danger ?? props.theme.colors.textDestructive ?? props.theme.colors.warning,
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
                            icon={<Ionicons name={isExpanded ? 'folder-open-outline' : 'folder-outline'} size={16} color={props.theme.colors.textLink} />}
                            density="tight"
                            rightElement={rightElement}
                            showChevron={false}
                            onPress={() => toggleDir(node.fullPath)}
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
                        <Text style={{ fontSize: 12, color: props.theme.colors.warning, ...Typography.mono('semiBold') }}>
                            {resolved.kindLetter}
                        </Text>
                        {resolved.added > 0 ? (
                            <Text style={{ fontSize: 12, color: props.theme.colors.success, ...Typography.mono('semiBold') }}>
                                {`+${resolved.added}`}
                            </Text>
                        ) : null}
                        {resolved.removed > 0 ? (
                            <Text
                                style={{
                                    fontSize: 12,
                                    color: props.theme.colors.danger ?? props.theme.colors.textDestructive ?? props.theme.colors.warning,
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
