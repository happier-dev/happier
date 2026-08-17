import * as React from 'react';
import { Platform, View, type ScrollViewProps } from 'react-native';
import type { useUnistyles } from 'react-native-unistyles';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserRowRenderInput } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWorkspaceRepositoryTreeBrowser } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex';
import { buildScmTreeBadgeSignature } from '@/components/workspaces/files/repositoryTree/scmTreeBadges';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

export type WorkspaceRepositoryTreeWebDropTarget = Readonly<{
    destinationDir: string;
    hoverPath: string | null;
    autoExpandDirectoryPath: string | null;
}>;

type WorkspaceRepositoryTreeNode = LazyDirectoryTreeNode;

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

type WorkspaceRepositoryTreeListProps = Readonly<{
    theme: AppTheme;
    /** The workspace, as one identity: what the tree is keyed by AND read through. */
    scope: WorkspaceScopeBase;
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
            <Icon
                name={node.isExpanded ? 'folder-open' : 'folder'}
                size={16}
                color={theme.colors.text.link}
            />
        );
    }
    if (node.type === 'error') {
        return <Icon name="warning-circle" size={16} color={theme.colors.text.secondary} />;
    }
    if (node.type === 'info') {
        return <Icon name="info" size={16} color={theme.colors.text.secondary} />;
    }
    return <FileIcon fileName={node.name} size={16} />;
}

export const WorkspaceRepositoryTreeList = React.memo(function WorkspaceRepositoryTreeList(props: WorkspaceRepositoryTreeListProps): React.ReactElement {
    const { theme, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const detailsMode = props.detailsMode === true;

    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory } = useWorkspaceRepositoryTreeBrowser({
        scope: props.scope,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
    });

    React.useEffect(() => {
        props.onRootLoadingChange?.(rootLoading);
    }, [props.onRootLoadingChange, rootLoading]);

    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);
    const badgeSignature = buildScmTreeBadgeSignature(props.scmSnapshot ?? null);
    const rowRenderState = React.useMemo(() => ({
        badgeIndex,
        detailsMode,
        onOpenFile,
        onOpenFilePinned: props.onOpenFilePinned,
        onWebDropTargetChange: props.onWebDropTargetChange,
        renderRowActions: props.renderRowActions,
        retryDirectory,
        scmSnapshot: props.scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath: props.webDropHoverPath,
    }), [
        badgeIndex,
        detailsMode,
        onOpenFile,
        props.onOpenFilePinned,
        props.onWebDropTargetChange,
        props.renderRowActions,
        retryDirectory,
        props.scmSnapshot,
        theme,
        toggleDirectory,
        props.webDropHoverPath,
    ]);
    const rowRenderStateRef = React.useRef(rowRenderState);
    rowRenderStateRef.current = rowRenderState;
    const rowVisualExtraData = React.useMemo(() => [
        badgeSignature,
        detailsMode ? 'details' : 'compact',
        props.renderRowActions ? 'actions' : 'no-actions',
        props.onWebDropTargetChange ? 'drop' : 'no-drop',
        props.webDropHoverPath ?? '',
        theme.colors.text?.secondary,
        theme.colors.text?.link,
        theme.colors.surface?.pressed,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.state?.danger?.foreground,
    ].join('|'), [
        badgeSignature,
        detailsMode,
        props.onWebDropTargetChange,
        props.renderRowActions,
        props.webDropHoverPath,
        theme.colors.state?.danger?.foreground,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.surface?.pressed,
        theme.colors.text?.link,
        theme.colors.text?.secondary,
    ]);

    const renderRow = React.useCallback(({ node, showDivider }: FilesystemBrowserRowRenderInput) => {
        const rowState = rowRenderStateRef.current;
        const rowTestId = `repository-tree-row-${toTestIdSafeValue(node.path)}`;
        const badge = rowState.badgeIndex
            ? (
                node.type === 'file'
                    ? rowState.badgeIndex.getFileBadge(node.path)
                    : node.type === 'directory'
                        ? rowState.badgeIndex.getDirectoryBadge(node.path)
                        : null
            )
            : null;

        const menu = rowState.renderRowActions ? rowState.renderRowActions(node) : null;

        const showDetailsInline = node.type !== 'error' && rowState.detailsMode && Platform.OS === 'web';
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
                                color: rowState.theme.colors.text.secondary,
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
                                color: rowState.theme.colors.text.secondary,
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
                        <Text style={{ fontSize: 12, color: rowState.theme.colors.state.neutral.foreground, ...Typography.mono('semiBold') }}>
                            {node.type === 'directory' ? `${badge.kindLetter}${badge.changedCount}` : badge.kindLetter}
                        </Text>
                        {badge.added > 0 ? (
                            <Text style={{ fontSize: 12, color: rowState.theme.colors.state.success.foreground, ...Typography.mono('semiBold') }}>
                                {`+${badge.added}`}
                            </Text>
                        ) : null}
                        {badge.removed > 0 ? (
                            <Text
                                style={{
                                    fontSize: 12,
                                    color: rowState.theme.colors.state.danger.foreground ?? rowState.theme.colors.state.neutral.foreground,
                                    ...Typography.mono('semiBold'),
                                }}
                            >
                                {`-${badge.removed}`}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {isDirectoryNode(node) && node.isLoadingChildren ? (
                    <ActivitySpinner size="small" color={rowState.theme.colors.text.secondary} />
                ) : null}
                {menu}
            </View>
        ) : undefined;

        const subtitle = (() => {
            if (node.type === 'error') return t('errors.tryAgain');
            if (node.type === 'info') return undefined;
            if (!rowState.detailsMode || Platform.OS === 'web') return undefined;
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
                icon={renderEntryIcon(node, rowState.theme)}
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
                        void rowState.retryDirectory(parentDirectoryPath);
                    }
                }}
                onPress={
                    node.type === 'error'
                        ? undefined
                        : node.type === 'file'
                            ? () => rowState.onOpenFile(node.path)
                            : () => {
                                void rowState.toggleDirectory(node.path);
                            }
                }
                onDoublePress={
                    node.type === 'file'
                        ? () => (rowState.onOpenFilePinned ?? rowState.onOpenFile)(node.path)
                        : undefined
                }
                paddingRight={8}
                style={{
                    backgroundColor: rowState.webDropHoverPath === node.path ? rowState.theme.colors.surface.pressed : undefined,
                    borderRadius: 10,
                }}
                wrapContent={
                    Platform.OS === 'web'
                        ? ({ content }) => {
                            const shouldWrapDropTarget =
                                (node.type === 'directory' || node.type === 'file')
                                && Boolean(rowState.onWebDropTargetChange);
                            const wrappedContent = shouldWrapDropTarget
                                ? (
                                    <WebDropTargetView
                                        onDragEnter={(event) => {
                                            if (!isWebFileDragEvent(event)) return;
                                            rowState.onWebDropTargetChange?.(buildWebDropTarget(node));
                                        }}
                                        onDragOver={(event) => {
                                            if (!isWebFileDragEvent(event)) return;
                                            event.preventDefault?.();
                                            rowState.onWebDropTargetChange?.(buildWebDropTarget(node));
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
    }, []);

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
            emptyIconName="folder"
            loadingLabel={t('common.loading')}
            inlineRetryLabel={t('errors.tryAgain')}
            renderRow={renderRow}
            extraData={rowVisualExtraData}
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
});
