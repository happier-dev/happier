import * as React from 'react';
import { ActivityIndicator, Platform, View, type ScrollViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRepositoryTreeBrowser } from '@/hooks/session/files/useRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { RepositoryTreeRowActionsMenu, type RepositoryTreeRowActionMenuItemId } from '@/components/sessions/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useRepositoryTreeRowActions } from '@/components/sessions/files/repositoryTree/useRepositoryTreeRowActions';
import { WebDropTargetView } from '@/components/sessions/files/repositoryTree/WebDropTargetView';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';

export type RepositoryTreeWebDropTarget = Readonly<{
    destinationDir: string;
    hoverPath: string | null;
    autoExpandDirectoryPath: string | null;
}>;

type RepositoryTreeListProps = {
    theme: any;
    sessionId: string;
    reloadToken?: number;
    detailsMode?: boolean;
    writeActionsEnabled?: boolean;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
    onWebDropTargetChange?: ((target: RepositoryTreeWebDropTarget) => void) | null;
    webDropHoverPath?: string | null;
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

function isDirectoryNode(node: { type: 'file' | 'directory' | 'error' | 'info' }): boolean {
    return node.type === 'directory';
}

function buildWebDropTarget(node: {
    type: 'file' | 'directory' | 'error' | 'info';
    path: string;
    parentDirectoryPath?: string | null;
    isExpanded?: boolean;
    isLoadingChildren?: boolean;
}): RepositoryTreeWebDropTarget {
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

function renderEntryIcon(node: { type: 'file' | 'directory' | 'error' | 'info'; name: string; isExpanded?: boolean }, theme: any) {
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
    if (node.type === 'info') {
        return <Ionicons name="information-circle-outline" size={16} color={theme.colors.textSecondary} />;
    }
    return <FileIcon fileName={node.name} size={16} />;
}

export function RepositoryTreeList(props: RepositoryTreeListProps): React.ReactElement {
    const { theme, sessionId, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const detailsMode = props.detailsMode === true;
    const writeActionsEnabled = props.writeActionsEnabled !== false;
    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory } = useRepositoryTreeBrowser({
        sessionId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
    });

    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);
    const rowActions = useRepositoryTreeRowActions({
        sessionId,
        writeActionsEnabled,
        expandedPaths,
        onExpandedPathsChange,
        onRequestRefresh: props.onRequestRefresh ?? null,
        onRequestDownload: props.onRequestDownload ?? null,
    });

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

    return (
        <FilesystemBrowser
            nodes={nodes}
            rootLoading={rootLoading}
            rootError={rootError}
            retryRoot={retryRoot}
            loadingLabel={t('common.loading')}
            inlineRetryLabel={t('common.retry')}
            listHeaderTestID="repository-tree-error-inline"
            emptyTestID="repository-tree-empty"
            emptyLabel={t('files.noFilesInProject')}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            renderRow={({ node, index, totalCount }) => {
                const safePath = toTestIdSafeValue(node.path);
                const rowTestId = `repository-tree-row-${safePath}`;
                const badge = (() => {
                    if (!props.scmSnapshot || !badgeIndex) return null;
                    if (node.type === 'file') return badgeIndex.getFileBadge(node.path);
                    if (node.type === 'directory') return badgeIndex.getDirectoryBadge(node.path);
                    return null;
                })();

                const showDetailsInline = node.type !== 'error' && detailsMode && Platform.OS === 'web';
                const detailsSize =
                    node.type === 'file' && typeof node.sizeBytes === 'number'
                        ? formatByteSize(node.sizeBytes)
                        : node.type === 'directory'
                            ? ''
                            : '';
                const detailsModified =
                    typeof node.modifiedMs === 'number'
                        ? new Date(node.modifiedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : '';

                const menu = (() => {
                    if (node.type !== 'file' && node.type !== 'directory') return null;
                    const actionTarget: Readonly<{ path: string; type: 'file' | 'directory' }> = {
                        path: node.path,
                        type: node.type,
                    };
                    return (
                        <RepositoryTreeRowActionsMenu
                            path={node.path}
                            kind={node.type}
                            disableWriteActions={!writeActionsEnabled}
                            onSelect={(itemId: RepositoryTreeRowActionMenuItemId) => rowActions.onSelectRowMenuItem(actionTarget, itemId)}
                        />
                    );
                })();

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
                                        color: theme.colors.textSecondary,
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
                                        color: theme.colors.textSecondary,
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
                        {menu}
                    </View>
                ) : undefined;

                const subtitle = (() => {
                    if (node.type === 'error') {
                        return t('errors.tryAgain');
                    }
                    if (node.type === 'info') {
                        return undefined;
                    }
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
                        node={node}
                        index={index}
                        totalCount={totalCount}
                        title={node.type === 'directory' ? `${node.name}/` : node.name}
                        subtitle={subtitle}
                        icon={renderEntryIcon(node, theme)}
                        density="tight"
                        rightElement={right}
                        testID={rowTestId}
                        errorTitle={t('files.repositoryFolderLoadFailed')}
                        errorSubtitle={t('errors.tryAgain')}
                        onRetryError={(errorNode) => {
                            if (errorNode.parentDirectoryPath) {
                                void retryDirectory(errorNode.parentDirectoryPath);
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
                            backgroundColor: props.webDropHoverPath === node.path ? theme.colors.surfacePressed : undefined,
                            borderRadius: 10,
                        }}
                        wrapContent={
                            Platform.OS === 'web' && (node.type === 'directory' || node.type === 'file') && props.onWebDropTargetChange
                                ? ({ content }) => {
                                    const dropTarget = buildWebDropTarget(node);
                                    return (
                                        <WebDropTargetView
                                            onDragEnter={(event) => {
                                                if (!isWebFileDragEvent(event)) return;
                                                props.onWebDropTargetChange?.(dropTarget);
                                            }}
                                            onDragOver={(event) => {
                                                if (!isWebFileDragEvent(event)) return;
                                                event.preventDefault?.();
                                                props.onWebDropTargetChange?.(dropTarget);
                                            }}
                                        >
                                            {content}
                                        </WebDropTargetView>
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
