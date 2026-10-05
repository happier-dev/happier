import { useRepositoryTreeVisibility } from '@/hooks/workspaces/files/useRepositoryTreeVisibility';
import { RepositoryTreeVisibilityControl } from '@/components/workspaces/files/repositoryTree/RepositoryTreeVisibilityControl';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RepositoryTreeToolbar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeToolbar';
import { RepositoryTreeCreateMenu, type RepositoryTreeCreateMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { Modal } from '@/modal';
import { t } from '@/text';

import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import { workspaceCreateDirectory, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { storage, useLocalSetting, useMachine, useServerScopedMachine, useWorkspaceRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useWorkspaceFileTransfers, type WorkspaceUploadEntry } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import { RepositoryTreeDropOverlay } from '@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay';
import { RepositoryTreeTransferStatusBar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeTransferStatusBar';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { showUploadConflictResolutionDialog } from '@/components/workspaces/files/repositoryTree/showUploadConflictResolutionDialog';
import { readRepositoryFileDropTarget } from '@/components/workspaces/files/repositoryTree/repositoryFileDropTarget';
import type { WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { promptRepositoryUploadDestination } from '@/components/workspaces/files/repositoryTree/promptRepositoryUploadDestination';
import { RepositoryTreeRowActionsMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { useWorkspaceRepositoryTreeWebDropState } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeWebDropState';
import { useRepositoryUploadActionTarget } from '@/components/workspaces/files/repositoryTree/useRepositoryUploadActionTarget';
import { useWorkspaceRepositoryTreeRowActions } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineDaemonFiniteTransferApplicationSupported } from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';
import { isMachineFiniteTransferRpcDeclared, readCurrentMachineIrohEndpoint, resolveMachineCarrierPreselection } from '@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection';
import { isBrowserIrohHost } from '@/sync/runtime/browserIroh/hostEligibility';
import {
    isIrohMachineTransferLifecycleAvailable,
    probeIrohMachineTransferLifecycleAvailability,
    subscribeIrohMachineTransferLifecycleAvailability,
} from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { WorkspaceRepositoryTreeList, type WorkspaceRepositoryTreeWebDropTarget } from './WorkspaceRepositoryTreeList';

export type WorkspaceRepositoryTreeBrowserViewProps = Readonly<{
    /**
     * The workspace, as ONE identity. This used to be a `workspaceCacheKey` alongside a
     * separate `machineId`/`rootPath`/`serverId` address, and this component is where the two
     * came apart: it passed the server-scoped key while calling the file search without the
     * server, so the index was built through the ACTIVE server and filed under the ADDRESSED
     * server's key — poisoning the entry the composer then read.
     */
    scope: WorkspaceScopeBase;
    onOpenFile: (fullPath: string) => void;
    fileHref?: (fullPath: string) => string | null;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
    revealRequest?: Readonly<{ path: string }>;
    scmSnapshot?: ScmWorkingSnapshot | null;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    onWebDropTargetChange?: ((target: WorkspaceRepositoryTreeWebDropTarget) => void) | null;
    webDropHoverPath?: string | null;
    renderRowActions?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowActions'];
    /** The file open in Details: its row stays selected (lab F1). */
    selectedPath?: string | null;
}>;


export const WorkspaceRepositoryTreeBrowserView = React.memo((props: WorkspaceRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const homeApplicationCarrierEligibility = useLocalSetting('homeApplicationCarrierEligibility');
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [treeRootLoading, setTreeRootLoading] = React.useState(false);
    const [uploadDestinationDir, setUploadDestinationDir] = React.useState('');

    // Stabilized on the three FIELDS: several hosts build this prop inline, and the search
    // effect / row actions below key on the scope OBJECT. A fresh literal every render would
    // re-run them every render — the primitive props they used to depend on could not.
    const workspaceScope = React.useMemo(
        () => props.scope,
        [props.scope.serverId, props.scope.machineId, props.scope.rootPath],
    );
    const { visibilityMode, setVisibilityMode, gitIgnoreAvailable, setGitIgnoreAvailable, revealedPaths, revealPath, latestRequest } = useRepositoryTreeVisibility(tryBuildWorkspaceCacheKey(workspaceScope) ?? '');
    const workspaceScmController = useWorkspaceScmSnapshotController(props.scmSnapshot === undefined ? workspaceScope : null);
    const effectiveScmSnapshot = props.scmSnapshot ?? workspaceScmController.snapshot ?? null;
    const globalMachine = useMachine(workspaceScope.machineId);
    const scopedMachine = useServerScopedMachine(workspaceScope.serverId, workspaceScope.machineId);
    const machine = scopedMachine ?? globalMachine;
    const machineRpcTargetAvailable = Boolean(machine && isMachineOnline(machine));
    const serverSnapshot = useServerFeaturesSnapshotForServerId(workspaceScope.serverId, {
        enabled: Boolean(workspaceScope.serverId) && machineRpcTargetAvailable,
    });
    const nativeMachineCarrierAvailable = React.useSyncExternalStore(
        subscribeIrohMachineTransferLifecycleAvailability,
        isIrohMachineTransferLifecycleAvailable,
        isIrohMachineTransferLifecycleAvailable,
    );
    React.useEffect(() => {
        if (homeApplicationCarrierEligibility !== 'standard_only') {
            void probeIrohMachineTransferLifecycleAvailability();
        }
    }, [homeApplicationCarrierEligibility]);
    const runnerFiniteTransferRpcDeclared = machine?.kind === 'ephemeral_session_runner' && isMachineFiniteTransferRpcDeclared({
        capabilities: machine?.operationProtocolCapabilities,
        revision: machine?.operationProtocolCapabilitiesRevision,
        active: machine?.active,
        revokedAt: machine?.revokedAt,
    });
    const transferPreselection = resolveMachineCarrierPreselection({
        applicationCarrierEligibility: homeApplicationCarrierEligibility,
        serverFeatures: serverSnapshot.status === 'ready' ? serverSnapshot.features : null,
        targetEndpoint: readCurrentMachineIrohEndpoint({
            capabilities: machine?.operationProtocolCapabilities,
            revision: machine?.operationProtocolCapabilitiesRevision,
            active: machine?.active,
            revokedAt: machine?.revokedAt,
        }),
        host: isBrowserIrohHost()
            ? { kind: 'browser' }
            : { kind: 'native', lifecycleAvailable: nativeMachineCarrierAvailable },
        finiteTransferApplicationSupported: machine?.kind === 'ephemeral_session_runner'
            ? runnerFiniteTransferRpcDeclared
            : isMachineDaemonFiniteTransferApplicationSupported(machine?.daemonState),
    });
    const transferActionsAvailable = machineRpcTargetAvailable && transferPreselection.kind !== 'unavailable';

    const workspaceExpandedPaths = useWorkspaceRepositoryTreeExpandedPaths(workspaceScope);

    const expandedPaths = props.expandedPaths ?? workspaceExpandedPaths;
    const setExpandedPaths = props.onExpandedPathsChange
        ?? ((paths: string[]) => storage.getState().setWorkspaceRepositoryTreeExpandedPaths(workspaceScope, paths));

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;

    const fileQuery = useWorkspaceFileQuery({ scope: workspaceScope, query: searchQuery, enabled: !showChangedOnly, limit: 200, reloadToken: treeReloadNonce });
    const searchResults = fileQuery.items;
    const isSearching = fileQuery.isSearching;

    const showSearchBar = props.showSearchBar !== false;
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const webFolderInputRef = React.useRef<HTMLInputElement | null>(null);
    const pickedUploadSelectionRef = React.useRef<Readonly<{ destinationDir: string; isCurrent: () => boolean }> | null>(null);
    const setWebFolderInputRef = React.useCallback((node: HTMLInputElement | null) => {
        webFolderInputRef.current = node;
        applyWebDirectoryInputAttributes(node);
    }, []);

    const handleRevealPath = React.useCallback((path: string, isDirectory = false) => {
        if (!isSafeWorkspaceRelativePath(path)) return;
        setSearchQuery('');
        setShowChangedOnly(false);
        revealPath(path, { focus: true });
        const current = storage.getState().getWorkspaceRepositoryTreeExpandedPaths(workspaceScope);
        const ancestors = computeExpandedPathsForReveal({ expandedPaths: current, fullPath: path });
        const next = isDirectory && !ancestors.includes(path) ? [...ancestors, path] : ancestors;
        if (props.onExpandedPathsChange) props.onExpandedPathsChange(next);
        else storage.getState().setWorkspaceRepositoryTreeExpandedPaths(workspaceScope, next);
    }, [workspaceScope, props.onExpandedPathsChange, setSearchQuery, revealPath]);

    React.useEffect(() => {
        if (props.revealRequest) handleRevealPath(props.revealRequest.path);
    }, [props.revealRequest, handleRevealPath]);

    const handleTreeOpenFile = React.useCallback((path: string) => {
        revealPath(path);
        props.onOpenFile(path);
    }, [props.onOpenFile, revealPath]);
    const handleTreeOpenFilePinned = React.useCallback((path: string) => {
        revealPath(path);
        (props.onOpenFilePinned ?? props.onOpenFile)(path);
    }, [props.onOpenFile, props.onOpenFilePinned, revealPath]);


    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;

    React.useEffect(() => {
        if (shouldShowSearchResults || showChangedOnly) {
            setTreeRootLoading(false);
        }
    }, [shouldShowSearchResults, showChangedOnly]);

    const refresh = React.useCallback(() => {
        workspaceFileSearchCache.clearCache(workspaceScope);
        const workspaceCacheKey = tryBuildWorkspaceCacheKey(workspaceScope);
        if (workspaceCacheKey) {
            clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey });
        }
        setTreeReloadNonce((n) => n + 1);
        if (props.scmSnapshot === undefined) {
            void workspaceScmController.refresh();
        }
    }, [props.scmSnapshot, workspaceScmController, workspaceScope]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);

    const allowCreateActions = React.useMemo(() => (
        Boolean(workspaceScope.machineId.trim() && workspaceScope.rootPath.trim())
    ), [workspaceScope]);
    const webDropState = useWorkspaceRepositoryTreeWebDropState({
        enabled: transferActionsAvailable && Platform.OS === 'web',
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
    });

    const createFile = React.useCallback(() => {
        if (!allowCreateActions) return;
        void (async () => {
            const raw = await Modal.prompt(
                t('files.createFilePromptTitle'),
                t('files.createFilePromptBody'),
                { placeholder: 'src/new-file.ts' },
            );
            if (typeof raw !== 'string') return;
            const path = raw.trim();
            if (!path) return;
            if (!isSafeWorkspaceRelativePath(path) || path.endsWith('/')) {
                Modal.alert(t('common.error'), t('files.createFileInvalidPath'));
                return;
            }

            const res = await workspaceWriteFile(workspaceScope, path, '', null);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFileFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: path,
            });
            setExpandedPaths(nextExpanded);
            refresh();
            revealPath(path);
            (props.onOpenFilePinned ?? props.onOpenFile)(path);
        })();
    }, [allowCreateActions, expandedPaths, props.onOpenFile, props.onOpenFilePinned, refresh, setExpandedPaths, workspaceScope, revealPath]);

    const createFolder = React.useCallback(() => {
        if (!allowCreateActions) return;
        void (async () => {
            const raw = await Modal.prompt(
                t('files.createFolderPromptTitle'),
                t('files.createFolderPromptBody'),
                { placeholder: 'src/new-folder' },
            );
            if (typeof raw !== 'string') return;
            const directoryPath = raw.trim().replace(/\/+$/, '');
            if (!directoryPath) return;
            if (!isSafeWorkspaceRelativePath(directoryPath)) {
                Modal.alert(t('common.error'), t('files.createFolderInvalidPath'));
                return;
            }

            const res = await workspaceCreateDirectory(workspaceScope, directoryPath);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: `${directoryPath}/.placeholder`,
            });
            revealPath(directoryPath);
            const withDir = nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath];
            setExpandedPaths(withDir);
            refresh();
        })();
    }, [allowCreateActions, expandedPaths, refresh, setExpandedPaths, workspaceScope, revealPath]);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });
    const rowActions = useWorkspaceRepositoryTreeRowActions({
        workspaceScope,
        writeActionsEnabled: allowCreateActions,
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        onRequestRefresh: refresh,
        onRequestDownload: (params) => transfers.startDownload(params),
    });

    const startWebUploads = React.useCallback(async (files: readonly File[], destinationDir: string) => {
        const entries: WorkspaceUploadEntry[] = files.map((file) => ({
            kind: 'web',
            file,
            relativePath: (file as any).webkitRelativePath || file.name,
        }));
        const res = await transfers.startUploads({ entries, destinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
    }, [transfers]);

    const startNativeUploads = React.useCallback(async (destinationDir: string, isCurrent: () => boolean) => {
        if (!isCurrent()) return 'cancelled' as const;
        const picked = await nativePickFiles({ multiple: true });
        if (!isCurrent()) return 'cancelled' as const;
        const nativePicked = picked.filter((p): p is Extract<NativePickedFile, { kind: 'native' }> => p.kind === 'native');
        if (nativePicked.length === 0) return 'cancelled' as const;
        const entries: WorkspaceUploadEntry[] = nativePicked.map((p) => ({
            kind: 'native',
            uri: p.uri,
            name: p.name,
            sizeBytes: p.sizeBytes,
            mimeType: p.mimeType,
            relativePath: p.name,
        }));
        const res = await transfers.startUploads({ entries, destinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
        return 'requested' as const;
    }, [transfers]);

    const captureCurrentUploadAcquisition = useRepositoryUploadActionTarget({
        workspaceScope,
        enabled: transferActionsAvailable,
        pick: async ({ kind, destinationDir, signal }, isCurrent) => {
            if (signal?.aborted) return { status: 'cancelled' };
            if (Platform.OS !== 'web') {
                if (kind === 'folder') return { status: 'unavailable' };
                return { status: await startNativeUploads(destinationDir, isCurrent) };
            }
            const input = kind === 'folder' ? webFolderInputRef.current : webFileInputRef.current;
            if (!input) return { status: 'unavailable' };
            pickedUploadSelectionRef.current = { destinationDir, isCurrent };
            input.click();
            return { status: 'requested' };
        },
    });

    const selectUploadDestination = React.useCallback(async () => {
        const nextDestination = await promptRepositoryUploadDestination(uploadDestinationDir);
        if (nextDestination === null) return;
        setUploadDestinationDir(nextDestination);
    }, [uploadDestinationDir]);

    const onSelectCreateMenuItem = React.useCallback((itemId: RepositoryTreeCreateMenuItemId) => {
        if (itemId === 'repository-tree-create-file') {
            createFile();
            return;
        }
        if (itemId === 'repository-tree-create-folder') {
            createFolder();
            return;
        }
        if (!transferActionsAvailable) return;
        if (itemId === 'repository-tree-upload-destination-select') {
            void selectUploadDestination();
            return;
        }
        if (itemId === 'repository-tree-upload-files') {
            if (Platform.OS === 'web') {
                const isCurrent = captureCurrentUploadAcquisition();
                if (!isCurrent()) return;
                pickedUploadSelectionRef.current = { destinationDir: uploadDestinationDir, isCurrent };
                webFileInputRef.current?.click();
                return;
            }
            void startNativeUploads(uploadDestinationDir, captureCurrentUploadAcquisition());
        }
        if (itemId === 'repository-tree-upload-folder') {
            if (Platform.OS !== 'web') return;
            const isCurrent = captureCurrentUploadAcquisition();
            if (!isCurrent()) return;
            pickedUploadSelectionRef.current = { destinationDir: uploadDestinationDir, isCurrent };
            webFolderInputRef.current?.click();
        }
    }, [captureCurrentUploadAcquisition, createFile, createFolder, selectUploadDestination, startNativeUploads, transferActionsAvailable, uploadDestinationDir]);

    const dropZoneHandlers = useWebFileDropZone({
        enabled: transferActionsAvailable && Platform.OS === 'web',
        onFileDragActiveChange: webDropState.onFileDragActiveChange,
        onFilesDropped: async (event: WebFileDragEvent) => {
            const dataTransfer = event?.dataTransfer;
            if (!dataTransfer) return;
            const destinationDir = readRepositoryFileDropTarget(event)?.destinationDir ?? '';
            // The browser supplies the concrete DataTransfer at this external boundary.
            const dropped = await readWebDroppedEntries(dataTransfer as DataTransfer);
            const entries: WorkspaceUploadEntry[] = dropped.map((entry) => ({
                kind: 'web',
                file: entry.file,
                relativePath: entry.relativePath,
            }));
            const res = await transfers.startUploads({ entries, destinationDir });
            if (!res.ok) {
                Modal.alert(t('common.error'), res.error);
            }
        },
    });

    const dropZoneHandlersWithRoot = React.useMemo(() => ({
        ...dropZoneHandlers,
        onDragEnter: (event: WebFileDragEvent) => {
            const target = readRepositoryFileDropTarget(event);
            if (target) {
                webDropState.onDropTargetChange(target);
                props.onWebDropTargetChange?.(target);
            }
            dropZoneHandlers.onDragEnter(event);
        },
        onDragOver: (event: WebFileDragEvent) => {
            const target = readRepositoryFileDropTarget(event);
            if (target) {
                webDropState.onDropTargetChange(target);
                props.onWebDropTargetChange?.(target);
            }
            dropZoneHandlers.onDragOver(event);
        },
    }), [dropZoneHandlers, webDropState.onDropTargetChange, props.onWebDropTargetChange]);

    const defaultRenderRowActions = React.useCallback<NonNullable<WorkspaceRepositoryTreeBrowserViewProps['renderRowActions']>>((node, control) => {
        if (node.type !== 'file' && node.type !== 'directory') return null;
        const nodeKind: 'file' | 'directory' = node.type === 'file' ? 'file' : 'directory';
        const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
            ? node.sizeBytes
            : null;
        return (
            <RepositoryTreeRowActionsMenu
                href={node.type === 'file' ? props.fileHref?.(node.path) : null}
                path={node.path}
                kind={nodeKind}
                disableWriteActions={!allowCreateActions}
                downloadActionsEnabled={transferActionsAvailable && (transferSizeBytes == null || transferSizeBytes >= 0)}
                onSelect={(itemId) => rowActions.onSelectRowMenuItem({ path: node.path, type: nodeKind }, itemId)}
                control={control}
            />
        );
    }, [allowCreateActions, props.fileHref, rowActions, transferActionsAvailable]);

    // This pane has no header of its own, so its + menu ends the toolbar (the session pane's header carries it).
    // The one changed-file count, needed only while its chip shows.
    const changedCount = showChangedOnly && effectiveScmSnapshot?.repo.isRepo === true ? selectScmChangedFiles(effectiveScmSnapshot).length : null;
    const machineName = machine ? getMachineDisplayName(machine).trim() || null : null;
    const createMenu = (
        <RepositoryTreeCreateMenu
            createEnabled={allowCreateActions}
            uploadEnabled={transferActionsAvailable}
            isWeb={Platform.OS === 'web'}
            uploadDestinationLabel={uploadDestinationDir || t('files.projectRoot')}
            onSelect={onSelectCreateMenuItem}
        />
    );
    const showAllFiles = React.useCallback(() => setShowChangedOnly(false), []);

    return (
        <View style={{ flex: 1 }}>
            {showSearchBar ? (
                <RepositoryTreeToolbar
                    testIDPrefix="workspace-repository-tree"
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    changedOnly={showChangedOnly}
                    changedCount={changedCount}
                    onChangedOnlyChange={setShowChangedOnly}
                    detailsMode={detailsMode}
                    onDetailsModeChange={setDetailsMode}
                    onCollapseAll={!showChangedOnly && expandedPaths.length > 0 ? collapseAll : null}
                    onRefresh={refresh}
                    refreshing={treeRootLoading}
                    trailing={createMenu}
                    onRequestClose={props.onRequestClose}
                />
            ) : null}
            {!showChangedOnly && !shouldShowSearchResults ? <RepositoryTreeVisibilityControl mode={visibilityMode} available={gitIgnoreAvailable} onChange={setVisibilityMode} /> : null}
            {Platform.OS === 'web' ? (
                <>
                    <input
                        data-testid="repository-tree-upload-input-files"
                        ref={webFileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        multiple
                        onChange={(e) => {
                            const selection = pickedUploadSelectionRef.current;
                            pickedUploadSelectionRef.current = null;
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0 && selection?.isCurrent()) {
                                void startWebUploads(files, selection.destinationDir);
                            }
                            e.target.value = '';
                        }}
                    />
                    {React.createElement('input', {
                        'data-testid': 'repository-tree-upload-input-folder',
                        ref: setWebFolderInputRef,
                        type: 'file',
                        style: { display: 'none' },
                        multiple: true,
                        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                            const selection = pickedUploadSelectionRef.current;
                            pickedUploadSelectionRef.current = null;
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0 && selection?.isCurrent()) {
                                void startWebUploads(files, selection.destinationDir);
                            }
                            e.target.value = '';
                        },
                    })}
                </>
            ) : null}
            <WebDropTargetView testID="repository-tree-drop-zone" style={{ flex: 1 }} {...dropZoneHandlersWithRoot}>
                <View style={{ flex: 1, position: 'relative' }}>
                    {shouldShowSearchResults ? (
                        <SearchResultsList
                            workspaceScope={workspaceScope}
                            fileHref={props.fileHref}
                            theme={theme}
                            isSearching={isSearching}
                            searchQuery={searchQuery}
                            searchResults={searchResults}
                            searchResultsQuery={fileQuery.resultQuery}
                            searchError={Boolean(fileQuery.error)}
                            hasMore={fileQuery.hasMore}
                            onRetry={fileQuery.retry}
                            onFolderPress={(folder) => handleRevealPath(folder.fullPath.replace(/\/+$/, ''), true)}
                            onFilePress={(file) => props.onOpenFile(file.fullPath)}
                            onFilePressPinned={(file) => (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath)}
                        />
                    ) : (
                        <WorkspaceRepositoryTreeList
                            fileHref={props.fileHref}
                            theme={theme}
                            scope={workspaceScope}
                            reloadToken={treeReloadNonce}
                            detailsMode={detailsMode}
                        visibilityMode={visibilityMode}
                        revealedPaths={revealedPaths}
                        revealRequest={latestRequest}
                        onGitIgnoreAvailableChange={setGitIgnoreAvailable}
                            expandedPaths={expandedPaths}
                            onExpandedPathsChange={(paths) => setExpandedPaths(paths)}
                            onOpenFile={handleTreeOpenFile}
                            onOpenFilePinned={handleTreeOpenFilePinned}
                            scmSnapshot={effectiveScmSnapshot}
                            webFileDropEnabled={transferActionsAvailable && Platform.OS === 'web'}
                            webDropHoverPath={props.webDropHoverPath ?? webDropState.dropHoverPath}
                            renderRowActions={props.renderRowActions ?? defaultRenderRowActions}
                            showInlineLoadingHeader={false}
                            onRootLoadingChange={setTreeRootLoading}
                            changedOnly={showChangedOnly}
                            onShowAllFiles={showAllFiles}
                            selectedPath={props.selectedPath ?? null}
                            machineName={machineName}
                        />
                    )}
                    <RepositoryTreeDropOverlay
                        visible={webDropState.fileDragActive}
                        destinationLabel={webDropState.dropDestinationDir || t('files.projectRoot')}
                    />
                </View>
                <RepositoryTreeTransferStatusBar
                    uploadState={transfers.uploadState}
                    downloadState={transfers.downloadState}
                    onCancelUploads={transfers.cancelUploads}
                    onCancelDownload={transfers.cancelDownload}
                />
            </WebDropTargetView>
        </View>
    );
});
