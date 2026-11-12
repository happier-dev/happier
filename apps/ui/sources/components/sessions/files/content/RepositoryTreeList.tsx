import { useFilesystemTreeKeyboard } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
import * as React from 'react';
import { Platform, View, type ScrollViewProps, type ViewStyle } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserRowRenderInput } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRepositoryTreeBrowser } from '@/hooks/session/files/useRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex';
import { buildScmTreeBadgeSignature, resolveScmTreeBadgeSourceSnapshot } from '@/components/sessions/files/repositoryTree/scmTreeBadges';
import { useScmStatusEntriesWindow } from '@/scm/entries/useScmStatusEntriesWindow';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { RepositoryTreeRowActionsMenu, type RepositoryTreeRowActionMenuItemId } from '@/components/sessions/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useRepositoryTreeRowActions } from '@/components/sessions/files/repositoryTree/useRepositoryTreeRowActions';
import { WebDropTargetView } from '@/components/sessions/files/repositoryTree/WebDropTargetView';
import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import { useSessionFileTransferAvailabilityResolver } from '@/components/sessions/files/useSessionFileTransferAvailability';
import { Icon } from '@/components/ui/icons/Icon';
import type { WorkspaceFileTransferResult } from '@/hooks/session/files/useWorkspaceFileTransfers';

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
    visibilityMode?: 'project' | 'all';
    revealedPaths?: readonly string[];
    revealRequest?: Readonly<{ path: string }>;
    onGitIgnoreAvailableChange?: (available: boolean | undefined) => void;
    writeActionsEnabled?: boolean;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<WorkspaceFileTransferResult>) | null;
    onWebDropTargetChange?: ((target: RepositoryTreeWebDropTarget) => void) | null;
    webDropHoverPath?: string | null;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    scmSnapshot?: ScmWorkingSnapshot | null;
    showInlineLoadingHeader?: boolean;
    onRootLoadingChange?: (loading: boolean) => void;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
};

const repositoryTreeListStyle = {
    flex: 1,
    minHeight: 0,
} satisfies ViewStyle;

const repositoryTreeContentContainerStyle = {
    paddingBottom: 20,
} satisfies ViewStyle;

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

export const RepositoryTreeList = React.memo(function RepositoryTreeList(props: RepositoryTreeListProps): React.ReactElement {
    const { theme, sessionId, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const {
        onOpenFilePinned,
        onRequestDownload,
        onWebDropTargetChange,
        scmSnapshot,
        webDropHoverPath,
    } = props;
    const detailsMode = props.detailsMode === true;
    const writeActionsEnabled = props.writeActionsEnabled !== false;
    const canDownload = useSessionFileTransferAvailabilityResolver(sessionId);
    const copyFeedback = useTemporaryCopyFeedback();
    const preservedPaths = React.useMemo(() => [
        ...(props.revealedPaths ?? []),
        ...(scmSnapshot?.entries.flatMap((entry) => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]) ?? []),
    ], [props.revealedPaths, scmSnapshot]);
    const { rootLoading, rootError, nodes, toggleDirectory, retryRoot, retryDirectory, gitIgnoreAvailable } = useRepositoryTreeBrowser({
        sessionId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
        visibilityMode: props.visibilityMode,
        preservedPaths,
    });

    React.useEffect(() => {
        props.onRootLoadingChange?.(rootLoading);
    }, [props.onRootLoadingChange, rootLoading]);

    React.useEffect(() => {
        props.onGitIgnoreAvailableChange?.(gitIgnoreAvailable);
    }, [props.onGitIgnoreAvailableChange, gitIgnoreAvailable]);

    const keyboardListRef = React.useRef<import('react-native').FlatList<import('@/components/ui/filesystemBrowser/filesystemBrowserTypes').FilesystemBrowserNode>>(null);
    const focusIndex = React.useCallback((index: number) => keyboardListRef.current?.scrollToIndex({ index, animated: false }), []);
    const treeKeyboard = useFilesystemTreeKeyboard(nodes, focusIndex);
    const focusedRevealRef = React.useRef<typeof props.revealRequest>(undefined);
    React.useEffect(() => {
        const request = props.revealRequest;
        if (!request || focusedRevealRef.current === request || !nodes.some(node => node.path === request.path)) return;
        focusedRevealRef.current = request;
        treeKeyboard.focusPath(request.path);
    }, [nodes, props.revealRequest, treeKeyboard.focusPath]);
    // Badges derive from entry rows. Under the summary/detail delivery split a
    // poll carries a summary (`entries: []`), so the open surface's demand-loaded
    // entries window is the live badge source; it stays idle (zero RPCs) whenever
    // the snapshot still carries the complete entry set.
    const entriesWindow = useScmStatusEntriesWindow({
        sessionId,
        snapshot: props.scmSnapshot ?? null,
    });
    const badgeSourceSnapshot = React.useMemo(
        () => resolveScmTreeBadgeSourceSnapshot({
            snapshot: props.scmSnapshot ?? null,
            windowEntries: entriesWindow.state.entries,
        }),
        [props.scmSnapshot, entriesWindow.state.entries],
    );
    const badgeIndex = useScmTreeBadgeIndex(badgeSourceSnapshot);
    const badgeSignature = React.useMemo(
        () => buildScmTreeBadgeSignature(badgeSourceSnapshot),
        [badgeSourceSnapshot],
    );
    const renderedBadgeSignature = badgeIndex ? badgeSignature : 'none';
    const rowActions = useRepositoryTreeRowActions({
        sessionId,
        writeActionsEnabled,
        expandedPaths,
        onExpandedPathsChange,
        onRequestRefresh: props.onRequestRefresh ?? null,
        onRequestDownload: props.onRequestDownload ?? null,
        onCopyPathSuccess: copyFeedback.markCopied,
    });

    const rowRenderStateRef = React.useRef({
        treeKeyboard,
        badgeIndex,
        canDownload,
        detailsMode,
        copiedPath: copyFeedback.copiedKey,
        onOpenFile,
        onOpenFilePinned,
        onRequestDownload,
        onWebDropTargetChange,
        retryDirectory,
        rowActions,
        scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath,
        writeActionsEnabled,
    });
    rowRenderStateRef.current = {
        treeKeyboard,
        badgeIndex,
        canDownload,
        detailsMode,
        copiedPath: copyFeedback.copiedKey,
        onOpenFile,
        onOpenFilePinned,
        onRequestDownload,
        onWebDropTargetChange,
        retryDirectory,
        rowActions,
        scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath,
        writeActionsEnabled,
    };

    const hasDownloadRequest = onRequestDownload != null;
    const rowVisualExtraData = React.useMemo(() => [
        treeKeyboard.activePath,
        renderedBadgeSignature,
        detailsMode ? 'details' : 'compact',
        copyFeedback.copiedKey ?? '',
        hasDownloadRequest ? 'download' : 'no-download',
        theme.colors.state?.danger?.foreground ?? '',
        theme.colors.state?.neutral?.foreground ?? '',
        theme.colors.state?.success?.foreground ?? '',
        theme.colors.surface?.pressed ?? '',
        theme.colors.text?.link ?? '',
        theme.colors.text?.secondary ?? '',
        webDropHoverPath ?? '',
        writeActionsEnabled ? 'write' : 'read',
    ].join('\u0001'), [
        detailsMode,
        copyFeedback.copiedKey,
        hasDownloadRequest,
        treeKeyboard.activePath,
        renderedBadgeSignature,
        theme.colors.state?.danger?.foreground,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.surface?.pressed,
        theme.colors.text?.link,
        theme.colors.text?.secondary,
        webDropHoverPath,
        writeActionsEnabled,
    ]);

    const renderRow = React.useCallback(({ node, index, totalCount }: FilesystemBrowserRowRenderInput) => {
        const {
            treeKeyboard,
            badgeIndex,
            canDownload,
            copiedPath,
            detailsMode,
            onOpenFile,
            onOpenFilePinned,
            onRequestDownload,
            onWebDropTargetChange,
            retryDirectory,
            rowActions,
            scmSnapshot,
            theme,
            toggleDirectory,
            webDropHoverPath,
            writeActionsEnabled,
        } = rowRenderStateRef.current;
        const safePath = toTestIdSafeValue(node.path);
        const rowTestId = `repository-tree-row-${safePath}`;
        const badge = (() => {
            if (!scmSnapshot || !badgeIndex) return null;
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
            const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
                ? node.sizeBytes
                : null;
            return (
                <RepositoryTreeRowActionsMenu
                    path={node.path}
                    kind={node.type}
                    disableWriteActions={!writeActionsEnabled}
                    downloadActionsEnabled={onRequestDownload != null && canDownload(transferSizeBytes)}
                    onSelect={(itemId: RepositoryTreeRowActionMenuItemId) => rowActions.onSelectRowMenuItem(actionTarget, itemId)}
                />
            );
        })();

        const shouldShowRight = showDetailsInline || Boolean(badge) || (isDirectoryNode(node) && node.isLoadingChildren) || Boolean(menu);
        const copyFeedbackVisible = copiedPath === node.path;
        const right = shouldShowRight ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {copyFeedbackVisible ? (
                    <CopiedPill
                        visible
                        testID={`repository-tree-copy-feedback:${safePath}`}
                    />
                ) : null}
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
                        {badge.isComplete !== false && badge.added > 0 ? (
                            <Text style={{ fontSize: 12, color: theme.colors.state.success.foreground, ...Typography.mono('semiBold') }}>
                                {`+${badge.added}`}
                            </Text>
                        ) : null}
                        {badge.isComplete !== false && badge.removed > 0 ? (
                            <Text
                                style={{
                                    fontSize: 12,
                                    color: theme.colors.state.danger.foreground ?? theme.colors.state.danger.foreground ?? theme.colors.state.neutral.foreground,
                                    ...Typography.mono('semiBold'),
                                }}
                            >
                                {`-${badge.removed}`}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {isDirectoryNode(node) && node.isLoadingChildren ? (
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
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
                treeItemProps={treeKeyboard.getRowProps(node,
                    node.type === 'directory' ? () => { void toggleDirectory(node.path); } : undefined,
                    node.type === 'file' ? () => (onOpenFilePinned ?? onOpenFile)(node.path) : undefined,
                )}
                node={node}
                index={index}
                totalCount={totalCount}
                title={node.type === 'directory' ? `${node.name}/` : node.name}
                subtitle={subtitle}
                icon={renderEntryIcon(node, theme)}
                density="tight"
                rightElement={right}
                testID={rowTestId}
                webRole={Platform.OS === 'web' ? 'treeitem' : undefined}
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
                        ? () => (onOpenFilePinned ?? onOpenFile)(node.path)
                        : undefined
                }
                paddingRight={8}
                style={{
                    backgroundColor: webDropHoverPath === node.path ? theme.colors.surface.pressed : undefined,
                    borderRadius: 10,
                }}
                wrapContent={
                    Platform.OS === 'web' && (node.type === 'directory' || node.type === 'file') && onWebDropTargetChange
                        ? ({ content }) => {
                            const dropTarget = buildWebDropTarget(node);
                            return (
                                <WebDropTargetView
                                    onDragEnter={(event) => {
                                        if (!isWebFileDragEvent(event)) return;
                                        onWebDropTargetChange?.(dropTarget);
                                    }}
                                    onDragOver={(event) => {
                                        if (!isWebFileDragEvent(event)) return;
                                        event.preventDefault?.();
                                        onWebDropTargetChange?.(dropTarget);
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
            treeRole
            listRef={keyboardListRef}
            nodes={nodes}
            rootLoading={rootLoading}
            showInlineLoadingHeader={props.showInlineLoadingHeader}
            rootError={rootError}
            retryRoot={retryRoot}
            loadingLabel={t('common.loading')}
            inlineRetryLabel={t('common.retry')}
            listHeaderTestID="repository-tree-error-inline"
            emptyTestID="repository-tree-empty"
            emptyLabel={t('files.noFilesInProject')}
            style={repositoryTreeListStyle}
            contentContainerStyle={repositoryTreeContentContainerStyle}
            extraData={rowVisualExtraData}
            renderRow={renderRow}
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
});
