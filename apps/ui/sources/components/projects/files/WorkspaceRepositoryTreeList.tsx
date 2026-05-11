import * as React from 'react';
import { ActivityIndicator, Platform, View, type ScrollViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { useUnistyles } from 'react-native-unistyles';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWorkspaceRepositoryTreeBrowser } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type WorkspaceRepositoryTreeWebDropTarget = Readonly<{
    destinationDir: string;
    hoverPath: string | null;
    autoExpandDirectoryPath: string | null;
}>;

type WorkspaceRepositoryTreeNode = LazyDirectoryTreeNode;

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

type WorkspaceRepositoryTreeListProps = Readonly<{
    theme: AppTheme;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
    reloadToken?: number;
    detailsMode?: boolean;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
    onWebDropTargetChange?: ((target: WorkspaceRepositoryTreeWebDropTarget) => void) | null;
    webDropHoverPath?: string | null;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    scmSnapshot?: ScmWorkingSnapshot | null;
    renderRowActions?: ((node: WorkspaceRepositoryTreeNode) => React.ReactNode) | null;
    showInlineLoadingHeader?: boolean;
    onRootLoadingChange?: (loading: boolean) => void;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
}>;

function isDirectoryNode(node: { type: WorkspaceRepositoryTreeNode['type'] }): boolean {
    return node.type === 'directory';
}

function buildWebDropTarget(node: WorkspaceRepositoryTreeNode): WorkspaceRepositoryTreeWebDropTarget {
    if (node.type === 'directory') {
        return {
            destinationDir: node.path,
            hoverPath: node.path,
            autoExpandDirectoryPath: !node.isExpanded && !node.isLoadingChildren ? node.path : null,
        };
    }
    return {
        destinationDir: node.parentDirectoryPath ?? '',
        hoverPath: node.path,
        autoExpandDirectoryPath: null,
    };
}

function renderEntryIcon(node: WorkspaceRepositoryTreeNode, theme: AppTheme) {
    if (node.type === 'directory') {
        return (
            <Ionicons
                name={node.isExpanded ? 'folder-open-outline' : 'folder-outline'}
                size={16}
                color={theme.colors.text.link}
            />
        );
    }
    if (node.type === 'error') {
        return <Ionicons name="alert-circle-outline" size={16} color={theme.colors.text.secondary} />;
    }
    if (node.type === 'info') {
        return <Ionicons name="information-circle-outline" size={16} color={theme.colors.text.secondary} />;
    }
    return <FileIcon fileName={node.name} size={16} />;
}

export function WorkspaceRepositoryTreeList(props: WorkspaceRepositoryTreeListProps): React.ReactElement {
    const { theme, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const detailsMode = props.detailsMode === true;

    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory } = useWorkspaceRepositoryTreeBrowser({
        workspaceCacheKey: props.workspaceCacheKey,
        machineId: props.machineId,
        rootPath: props.rootPath,
        serverId: props.serverId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
    });

    React.useEffect(() => {
        props.onRootLoadingChange?.(rootLoading);
    }, [props.onRootLoadingChange, rootLoading]);

    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);

    if (rootError && nodes.length === 0) {
        return (
            <View testID="workspace-repository-tree-error" style={{ flex: 1 }}>
                <SourceControlUnavailableState
                    details={rootError}
                    onRetry={() => {
                        void retryRoot();
                    }}
                />
            </View>
        );
    }

    return (
        <FilesystemBrowser
            nodes={nodes}
            rootLoading={rootLoading}
            showInlineLoadingHeader={props.showInlineLoadingHeader}
            rootError={rootError}
            retryRoot={retryRoot}
            emptyLabel={t('files.noFilesInProject')}
            emptyIconName="folder-outline"
            loadingLabel={t('common.loading')}
            inlineRetryLabel={t('errors.tryAgain')}
            renderRow={({ node, showDivider }) => {
                const rowTestId = `repository-tree-row-${toTestIdSafeValue(node.path)}`;
                const badge = badgeIndex
                    ? (
                        node.type === 'file'
                            ? badgeIndex.getFileBadge(node.path)
                            : node.type === 'directory'
                                ? badgeIndex.getDirectoryBadge(node.path)
                                : null
                    )
                    : null;

                const menu = props.renderRowActions ? props.renderRowActions(node) : null;

                const showDetailsInline = node.type !== 'error' && detailsMode && Platform.OS === 'web';
                const detailsSize =
                    node.type === 'file' && typeof node.sizeBytes === 'number'
                        ? formatByteSize(node.sizeBytes)
                        : '';
                const detailsModified =
                    typeof node.modifiedMs === 'number'
                        ? new Date(node.modifiedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : '';

                const shouldShowRight = showDetailsInline || Boolean(badge) || (isDirectoryNode(node) && node.isLoadingChildren) || Boolean(menu);
                const right = shouldShowRight ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        {showDetailsInline ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                <Text
                                    style={{
                                        width: 74,
                                        textAlign: 'right',
                                        fontSize: 12,
                                        color: theme.colors.text.secondary,
                                        ...Typography.mono(),
                                    }}
                                    numberOfLines={1}
                                >
                                    {detailsSize}
                                </Text>
                                <Text
                                    style={{
                                        width: 132,
                                        textAlign: 'right',
                                        fontSize: 12,
                                        color: theme.colors.text.secondary,
                                        ...Typography.mono(),
                                    }}
                                    numberOfLines={1}
                                >
                                    {detailsModified}
                                </Text>
                            </View>
                        ) : null}
                        {badge ? (
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                                <Text style={{ fontSize: 12, color: theme.colors.state.neutral.foreground, ...Typography.mono('semiBold') }}>
                                    {node.type === 'directory' ? `${badge.kindLetter}${badge.changedCount}` : badge.kindLetter}
                                </Text>
                                {badge.added > 0 ? (
                                    <Text style={{ fontSize: 12, color: theme.colors.state.success.foreground, ...Typography.mono('semiBold') }}>
                                        {`+${badge.added}`}
                                    </Text>
                                ) : null}
                                {badge.removed > 0 ? (
                                    <Text
                                        style={{
                                            fontSize: 12,
                                            color: theme.colors.state.danger.foreground ?? theme.colors.state.neutral.foreground,
                                            ...Typography.mono('semiBold'),
                                        }}
                                    >
                                        {`-${badge.removed}`}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}
                        {isDirectoryNode(node) && node.isLoadingChildren ? (
                            <ActivityIndicator size="small" color={theme.colors.text.secondary} />
                        ) : null}
                        {menu}
                    </View>
                ) : undefined;

                const subtitle = (() => {
                    if (node.type === 'error') return t('errors.tryAgain');
                    if (node.type === 'info') return undefined;
                    if (!detailsMode || Platform.OS === 'web') return undefined;
                    const parts: string[] = [];
                    if (node.type === 'file' && typeof node.sizeBytes === 'number') {
                        parts.push(formatByteSize(node.sizeBytes));
                    }
                    if (typeof node.modifiedMs === 'number') {
                        parts.push(new Date(node.modifiedMs).toLocaleString());
                    }
                    return parts.length > 0 ? parts.join(' · ') : undefined;
                })();

                return (
                    <FilesystemBrowserRow
                        testID={rowTestId}
                        node={node}
                        title={node.type === 'directory' ? `${node.name}/` : node.name}
                        subtitle={subtitle}
                        icon={renderEntryIcon(node, theme)}
                        density="tight"
                        showDivider={showDivider}
                        rightElement={right}
                        errorTitle={t('files.repositoryFolderLoadFailed')}
                        errorSubtitle={t('errors.tryAgain')}
                        onRetryError={(errorNode: WorkspaceRepositoryTreeNode) => {
                            const parentDirectoryPath =
                                typeof errorNode.parentDirectoryPath === 'string' && errorNode.parentDirectoryPath.trim()
                                    ? errorNode.parentDirectoryPath
                                    : null;
                            if (parentDirectoryPath) {
                                void retryDirectory(parentDirectoryPath);
                            }
                        }}
                        onPress={
                            node.type === 'error'
                                ? undefined
                                : node.type === 'file'
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
                        paddingRight={8}
                        style={{
                            backgroundColor: props.webDropHoverPath === node.path ? theme.colors.surface.pressed : undefined,
                            borderRadius: 10,
                        }}
                        wrapContent={
                            Platform.OS === 'web'
                                ? ({ content }) => {
                                    const shouldWrapDropTarget =
                                        (node.type === 'directory' || node.type === 'file')
                                        && Boolean(props.onWebDropTargetChange);
                                    const wrappedContent = shouldWrapDropTarget
                                        ? (
                                            <WebDropTargetView
                                                onDragEnter={(event) => {
                                                    if (!isWebFileDragEvent(event)) return;
                                                    props.onWebDropTargetChange?.(buildWebDropTarget(node));
                                                }}
                                                onDragOver={(event) => {
                                                    if (!isWebFileDragEvent(event)) return;
                                                    event.preventDefault?.();
                                                    props.onWebDropTargetChange?.(buildWebDropTarget(node));
                                                }}
                                            >
                                                {content}
                                            </WebDropTargetView>
                                        )
                                        : content;

                                    return (
                                        <View testID={`${rowTestId}-drop-target`}>
                                            {wrappedContent}
                                        </View>
                                    );
                                }
                                : null
                        }
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
