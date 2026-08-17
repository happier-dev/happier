import * as React from 'react';
import { Platform, View, type ScrollViewProps, type ViewStyle } from 'react-native';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import type { FilesystemBrowserRowRenderInput } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRepositoryTreeBrowser } from '@/hooks/session/files/useRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex';
import { buildScmTreeBadgeSignature } from '@/components/workspaces/files/repositoryTree/scmTreeBadges';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { RepositoryTreeRowActionsMenu, type RepositoryTreeRowActionMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useRepositoryTreeRowActions } from '@/components/sessions/files/repositoryTree/useRepositoryTreeRowActions';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import { useSessionFileTransferAvailabilityState } from '@/components/sessions/files/useSessionFileTransferAvailability';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

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

const repositoryTreeListStyle: ViewStyle = { flex: 1, minHeight: 0 };
const repositoryTreeContentContainerStyle: ViewStyle = { paddingBottom: 20 };
const repositoryTreeWebItemLayout = (_data: unknown, index: number) => {
    const length = 38;
    return { length, offset: length * index, index };
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

export function RepositoryTreeList(props: RepositoryTreeListProps): React.ReactElement {
    const { theme, sessionId, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const detailsMode = props.detailsMode === true;
    const writeActionsEnabled = props.writeActionsEnabled !== false;
    const transferAvailability = useSessionFileTransferAvailabilityState(sessionId);
    const canDownload = React.useCallback((_transferSizeBytes?: number | null) => {
        return transferAvailability.available;
    }, [transferAvailability.available]);
    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory } = useRepositoryTreeBrowser({
        sessionId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
    });

    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);
    const badgeSignature = buildScmTreeBadgeSignature(props.scmSnapshot ?? null);
    const rowActions = useRepositoryTreeRowActions({
        sessionId,
        writeActionsEnabled,
        expandedPaths,
        onExpandedPathsChange,
        onRequestRefresh: props.onRequestRefresh ?? null,
        onRequestDownload: props.onRequestDownload ?? null,
    });

    const rowRenderState = React.useMemo(() => ({
        badgeIndex,
        canDownload,
        detailsMode,
        onOpenFile,
        onOpenFilePinned: props.onOpenFilePinned,
        onRequestDownload: props.onRequestDownload,
        onWebDropTargetChange: props.onWebDropTargetChange,
        retryDirectory,
        rowActions,
        scmSnapshot: props.scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath: props.webDropHoverPath,
        writeActionsEnabled,
    }), [
        badgeIndex,
        canDownload,
        detailsMode,
        onOpenFile,
        props.onOpenFilePinned,
        props.onRequestDownload,
        props.onWebDropTargetChange,
        retryDirectory,
        rowActions,
        props.scmSnapshot,
        theme,
        toggleDirectory,
        props.webDropHoverPath,
        writeActionsEnabled,
    ]);
    const rowRenderStateRef = React.useRef(rowRenderState);
    rowRenderStateRef.current = rowRenderState;
    const rowVisualExtraData = React.useMemo(() => [
        badgeSignature,
        detailsMode ? 'details' : 'compact',
        props.onRequestDownload ? 'download' : 'no-download',
        transferAvailability.available ? 'transfer' : 'no-transfer',
        props.webDropHoverPath ?? '',
        writeActionsEnabled ? 'write' : 'read',
        theme.colors.text?.secondary ?? theme.colors.textSecondary,
        theme.colors.text?.link ?? theme.colors.textLink,
        theme.colors.surface?.pressed ?? theme.colors.surfacePressed,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground ?? theme.colors.success,
        theme.colors.state?.danger?.foreground ?? theme.colors.textDestructive,
    ].join('|'), [
        badgeSignature,
        detailsMode,
        props.onRequestDownload,
        theme.colors.state?.danger?.foreground,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.success,
        theme.colors.surface?.pressed,
        theme.colors.surfacePressed,
        theme.colors.text?.link,
        theme.colors.text?.secondary,
        theme.colors.textDestructive,
        theme.colors.textLink,
        theme.colors.textSecondary,
        transferAvailability.available,
        props.webDropHoverPath,
        writeActionsEnabled,
    ]);

    const renderRow = React.useCallback(({ node, showDivider }: FilesystemBrowserRowRenderInput) => {
        const rowState = rowRenderStateRef.current;
        const safePath = toTestIdSafeValue(node.path);
        const rowTestId = `repository-tree-row-${safePath}`;
        const badge = (() => {
            if (!rowState.scmSnapshot || !rowState.badgeIndex) return null;
            if (node.type === 'file') return rowState.badgeIndex.getFileBadge(node.path);
            if (node.type === 'directory') return rowState.badgeIndex.getDirectoryBadge(node.path);
            return null;
        })();

        const showDetailsInline = node.type !== 'error' && rowState.detailsMode && Platform.OS === 'web';
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
            const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
                ? node.sizeBytes
                : null;
            return (
                <RepositoryTreeRowActionsMenu
                    path={node.path}
                    kind={node.type}
                    disableWriteActions={!rowState.writeActionsEnabled}
                    downloadActionsEnabled={rowState.onRequestDownload != null && rowState.canDownload(transferSizeBytes)}
                    onSelect={(itemId: RepositoryTreeRowActionMenuItemId) => rowState.rowActions.onSelectRowMenuItem(actionTarget, itemId)}
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
            if (node.type === 'error') {
                return t('errors.tryAgain');
            }
            if (node.type === 'info') {
                return undefined;
            }
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
                node={node}
                title={node.type === 'directory' ? `${node.name}/` : node.name}
                subtitle={subtitle}
                icon={renderEntryIcon(node, rowState.theme)}
                density="tight"
                showDivider={showDivider}
                rightElement={right}
                testID={rowTestId}
                errorTitle={t('files.repositoryFolderLoadFailed')}
                errorSubtitle={t('errors.tryAgain')}
                onRetryError={(errorNode) => {
                    if (errorNode.parentDirectoryPath) {
                        void rowState.retryDirectory(errorNode.parentDirectoryPath);
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
                    Platform.OS === 'web' && (node.type === 'directory' || node.type === 'file') && rowState.onWebDropTargetChange
                        ? ({ content }) => {
                            const dropTarget = buildWebDropTarget(node);
                            return (
                                <WebDropTargetView
                                    onDragEnter={(event) => {
                                        if (!isWebFileDragEvent(event)) return;
                                        rowState.onWebDropTargetChange?.(dropTarget);
                                    }}
                                    onDragOver={(event) => {
                                        if (!isWebFileDragEvent(event)) return;
                                        event.preventDefault?.();
                                        rowState.onWebDropTargetChange?.(dropTarget);
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
    }, []);

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
            style={repositoryTreeListStyle}
            contentContainerStyle={repositoryTreeContentContainerStyle}
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
            getItemLayout={Platform.OS === 'web' ? repositoryTreeWebItemLayout : undefined}
        />
    );
}
