import * as React from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, View, type ScrollViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRepositoryTreeBrowser } from '@/hooks/session/files/useRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex';

type RepositoryTreeListProps = {
    theme: any;
    sessionId: string;
    reloadToken?: number;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    scmSnapshot?: ScmWorkingSnapshot | null;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
};

function isDirectoryNode(node: { type: 'file' | 'directory' | 'error' }): boolean {
    return node.type === 'directory';
}

function renderEntryIcon(node: { type: 'file' | 'directory' | 'error'; name: string; isExpanded?: boolean }, theme: any) {
    if (node.type === 'directory') {
        // Keep icons small so the compact Item density actually stays compact.
        return (
            <Ionicons
                name={node.isExpanded ? 'folder-open-outline' : 'folder-outline'}
                size={16}
                color={theme.colors.textLink}
            />
        );
    }
    if (node.type === 'error') {
        return <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />;
    }
    return <FileIcon fileName={node.name} size={16} />;
}

export function RepositoryTreeList(props: RepositoryTreeListProps): React.ReactElement {
    const { theme, sessionId, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory } = useRepositoryTreeBrowser({
        sessionId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
    });

    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);

    if (rootLoading && nodes.length === 0) {
        return (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                }}
            >
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (rootError && nodes.length === 0) {
        return (
            <View testID="repository-tree-error" style={{ flex: 1 }}>
                <SourceControlUnavailableState
                    details={rootError}
                    onRetry={() => {
                        void retryRoot();
                    }}
                />
            </View>
        );
    }

    if (nodes.length === 0) {
        return (
            <View
                testID="repository-tree-empty"
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                paddingHorizontal: 20,
                }}
            >
                <Ionicons name="folder-outline" size={48} color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.noFilesInProject')}
                </Text>
            </View>
        );
    }

    return (
        <FlatList
            data={nodes}
            keyExtractor={(node) => `${node.type}:${node.path}`}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            ListHeaderComponent={
                rootLoading ? (
                    <View
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                        }}
                    >
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('common.loading')}
                        </Text>
                    </View>
                ) : rootError ? (
                    <View
                        testID="repository-tree-error-inline"
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                        }}
                    >
                        <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('errors.tryAgain')}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                            onPress={() => {
                                void retryRoot();
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                        >
                            <Text style={{ fontSize: 12, color: theme.colors.textLink, ...Typography.default('semiBold') }}>
                                {t('common.retry')}
                            </Text>
                        </Pressable>
                    </View>
                ) : null
            }
            renderItem={({ item: node, index }) => {
                const indent = Math.min(6, Math.max(0, node.depth));
                const paddingLeft = 12 + indent * 12;
                const showDivider = index < nodes.length - 1;
                const badge = (() => {
                    if (!props.scmSnapshot || !badgeIndex) return null;
                    if (node.type === 'file') return badgeIndex.getFileBadge(node.path);
                    if (node.type === 'directory') return badgeIndex.getDirectoryBadge(node.path);
                    return null;
                })();

                if (node.type === 'error') {
                    return (
                        <Item
                            title={t('files.repositoryFolderLoadFailed')}
                            subtitle={t('errors.tryAgain')}
                            icon={<Ionicons name="alert-circle-outline" size={18} color={theme.colors.textSecondary} />}
                            density="tight"
                            showChevron={false}
                            onPress={() => {
                                if (node.parentDirectoryPath) {
                                    void retryDirectory(node.parentDirectoryPath);
                                }
                            }}
                            showDivider={showDivider}
                            style={{
                                paddingLeft,
                                paddingRight: 12,
                            }}
                        />
                    );
                }

                const shouldShowRight = Boolean(badge) || (isDirectoryNode(node) && node.isLoadingChildren);

                const right = shouldShowRight ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        {badge ? (
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                                <Text style={{ fontSize: 12, color: theme.colors.warning, ...Typography.mono('semiBold') }}>
                                    {node.type === 'directory' ? `${badge.kindLetter}${badge.changedCount}` : badge.kindLetter}
                                </Text>
                                {badge.added > 0 ? (
                                    <Text style={{ fontSize: 12, color: theme.colors.success, ...Typography.mono('semiBold') }}>
                                        {`+${badge.added}`}
                                    </Text>
                                ) : null}
                                {badge.removed > 0 ? (
                                    <Text
                                        style={{
                                            fontSize: 12,
                                            color: theme.colors.danger ?? theme.colors.textDestructive ?? theme.colors.warning,
                                            ...Typography.mono('semiBold'),
                                        }}
                                    >
                                        {`-${badge.removed}`}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}
                        {isDirectoryNode(node) && node.isLoadingChildren ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : null}
                    </View>
                ) : undefined;

                const title = node.type === 'directory' ? `${node.name}/` : node.name;

                return (
                    <Item
                        title={title}
                        icon={renderEntryIcon(node, theme)}
                        density="tight"
                        rightElement={right}
                        showChevron={false}
                        onPress={
                            node.type === 'file'
                                ? () => onOpenFile(node.path)
                                : () => {
                                    void toggleDirectory(node.path);
                                }
                        }
                        onDoublePress={
                            node.type === 'file'
                                ? () => (props.onOpenFilePinned ?? onOpenFile)(node.path)
                                : undefined
                        }
                        showDivider={showDivider}
                        style={{
                            paddingLeft,
                            paddingRight: 8,
                        }}
                    />
                );
            }}
            initialNumToRender={Math.min(32, nodes.length)}
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
}
