import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { useQuickOpenFilesLauncher } from '@/components/workspaces/files/useQuickOpenEmptyState';
import * as React from 'react';
import { Platform, View, type ScrollViewProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RepositoryTreeToolbar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeToolbar';
import { RepositoryTreeCreateMenu, type RepositoryTreeCreateMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import { Modal } from '@/modal';
import { t } from '@/text';

import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import { UNIVERSAL_SEARCH_PAGE_SIZE } from '@/components/appShell/search/universalSearchResult';
import { workspaceCreateDirectory, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { storage, useActiveServerAccountScope, useLocalSetting, useServerScopedMachine, useWorkspaceRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { usePaneHeaderSlotContent, type PaneHeaderLine } from '@/components/appShell/panes/paneHeaderSlot';
import { CheckoutReachabilityLine, CheckoutReachabilityScope, describeCheckoutUnreachable, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { useIsWidgetFrameBody } from '@/components/widgets/frame/widgetFrameBody';
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
import { RepositoryTreeRowActionsMenu, type RepositoryTreeRowShareTarget } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import type { WorkspaceFileTarget } from '@happier-dev/protocol/actions/workspaceActionFamily';
import type { FileMenuContext } from '@/components/workspaces/files/file/fileMenus';
import { useWorkspaceRepositoryTreeWebDropState } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeWebDropState';
import { useRepositoryUploadActionTarget } from '@/components/workspaces/files/repositoryTree/useRepositoryUploadActionTarget';
import { useWorkspaceRepositoryTreeRowActions } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { isMachineDaemonFiniteTransferApplicationSupported, isMachineDaemonIrohTransferApplicationSupported } from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';
import { isMachineFiniteTransferRpcDeclared, readCurrentMachineIrohEndpoint, resolveMachineCarrierHostEligibility, resolveMachineCarrierPreselection } from '@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection';
import { resolveBrowserIrohHostDecision } from '@/sync/runtime/browserIroh/hostEligibility';
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
    /** Target-aware review callbacks (Discard) are supplied by the Session/Project opener owner. */
    buildFileMenuContext?: (path: string) => Partial<FileMenuContext>;
    /** Where a row's Copy Happier link opens; a Session tree defaults to its Session. */
    fileLinkTarget?: WorkspaceFileTarget | null;
    /** An inline create/rename field retains its rows until the interaction finishes. */
    reconciliationPaused?: boolean;
    /** The file open in Details: its row stays selected (lab F1). */
    selectedPath?: string | null;
    /** Session adapters may restrict effects, never substitute another Home's target. */
    effectsEnabled?: boolean;
    transferEffectsEnabled?: boolean;
    contextKey?: string;
    /** The Session these files belong to: quick open from the tree lists what it changed (lab FB2). */
    sessionId?: string | null;
    rootLabel?: string;
    rootHeading?: React.ReactNode;
    machineName?: string | null;
    createMenuPlacement?: 'toolbar' | 'paneHeader';
    /** With `paneHeader` placement: what this pane is about, on the pane header's live line beside the + menu. */
    paneHeaderLine?: PaneHeaderLine | null;
    onRefreshScm?: () => void;
    scrollProps?: Pick<ScrollViewProps, 'onLayout' | 'onContentSizeChange' | 'onScroll' | 'scrollEventThrottle'>;
    scrollOverlay?: React.ReactNode;
    /**
     * A Code folder page (plan 13 §2, lab p-code BROWSE): one folder's entries drawn in place as the
     * page's table — compact controls without another search, the name goes into the folder, the chevron opens it inline —
     * keeping this browser's row actions, uploads, drops and transfers.
     */
    folderPage?: Readonly<{
        path: string;
        onOpenFolder: (path: string) => void;
        renderRowMetadata?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowMetadata'];
        renderRowSubtitle?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowSubtitle'];
        onNodesChange?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['onNodesChange'];
        onVisibleNodesChange?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['onVisibleNodesChange'];
        listHeader?: React.ReactElement | null;
        listFooter?: React.ReactElement | null;
        listEmpty?: React.ReactElement | null;
        /** A preview (the Overview Code widget): the first rows only; the host says how many there are and leads to Code. */
        maxRows?: number | null;
        /**
         * The page places the browser's parts: its controls (View, with ignored files as a choice, and
         * the + menu) go in the page's own bar beside Go to file, and the listing body under it. Without
         * it the controls stay a row above the listing.
         */
        compose?: (parts: Readonly<{ controls: React.ReactNode; body: React.ReactNode; status: React.ReactNode }>) => React.ReactNode;
    }> | null;
}>;

const FILL_BODY_STYLE = { flex: 1, minHeight: 0 } as const;
const COMPOSED_BODY_STYLE = { flexGrow: 0, flexShrink: 1, minHeight: 0 } as const;

function BrowserPaneHeader(props: Readonly<{ action: React.ReactNode; line?: PaneHeaderLine | null }>) {
    usePaneHeaderSlotContent(React.useMemo(() => ({ action: props.action, line: props.line }), [props.action, props.line]));
    return null;
}

export const WorkspaceRepositoryTreeBrowserView = React.memo((props: WorkspaceRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const homeApplicationCarrierEligibility = useLocalSetting('homeApplicationCarrierEligibility');
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
    const { visibilityMode, setVisibilityMode, gitIgnoreAvailable, setGitIgnoreAvailable, revealedPaths, revealPath, latestRequest,
        changedOnly: storedChangedOnly, setChangedOnly: setShowChangedOnly, detailsMode, setDetailsMode,
        searchQuery: uncontrolledSearchQuery, setSearchQuery: setUncontrolledSearchQuery } = useRepositoryTreeBrowserState(tryBuildWorkspaceCacheKey(workspaceScope) ?? '');
    // Changed-only and file-query modes belong to the tree; a Code page always lists its folder.
    const machine = useServerScopedMachine(workspaceScope.serverId, workspaceScope.machineId);
    const presence = useMachinePresenceSummary(workspaceScope.serverId, workspaceScope.machineId);
    const machineRpcTargetAvailable = props.effectsEnabled !== false && presence.reachability === 'reachable';
    // Said once: here, unless the page above already says its checkout's machine isn't answering.
    const reachability = useCheckoutReachability(workspaceScope);
    // A widget body is the folder itself (lab p-overview HOME): its tools live on the Code page.
    const widget = useIsWidgetFrameBody();
    const workspaceScmController = useWorkspaceScmSnapshotController(props.scmSnapshot === undefined && machineRpcTargetAvailable ? workspaceScope : null);
    const effectiveScmSnapshot = props.scmSnapshot !== undefined ? props.scmSnapshot : workspaceScmController.snapshot ?? null;
    // The one changed-file count (the header's, Git's): unknown keeps the All | Changed control, a known
    // zero (or no repository) hides it and shows every file (lab FB1z).
    const changedCount = effectiveScmSnapshot == null ? null
        : effectiveScmSnapshot.repo.isRepo !== true ? 'none' as const
            : selectScmChangedFiles(effectiveScmSnapshot).length || 'none' as const;
    // Changed only belongs to the tree; a Code page always lists its folder.
    const showChangedOnly = props.folderPage ? false : storedChangedOnly && changedCount !== 'none';
    const launchQuickOpen = useQuickOpenFilesLauncher({ scope: workspaceScope, sessionId: props.sessionId });
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
        host: resolveMachineCarrierHostEligibility({ browserIroh: resolveBrowserIrohHostDecision(), nativeLifecycleAvailable: nativeMachineCarrierAvailable }),
        finiteTransferApplicationSupported: machine?.kind === 'ephemeral_session_runner'
            ? runnerFiniteTransferRpcDeclared
            : isMachineDaemonFiniteTransferApplicationSupported(machine?.daemonState),
        irohApplicationSupported: machine?.kind === 'ephemeral_session_runner'
            ? runnerFiniteTransferRpcDeclared : isMachineDaemonIrohTransferApplicationSupported(machine?.daemonState),
    });
    const transferActionsAvailable = props.transferEffectsEnabled !== false && machineRpcTargetAvailable && transferPreselection.kind !== 'unavailable';

    const workspaceExpandedPaths = useWorkspaceRepositoryTreeExpandedPaths(workspaceScope);

    const expandedPaths = props.expandedPaths ?? workspaceExpandedPaths;
    const setExpandedPaths = React.useCallback((paths: string[]) => {
        if (props.onExpandedPathsChange) props.onExpandedPathsChange(paths);
        else storage.getState().setWorkspaceRepositoryTreeExpandedPaths(workspaceScope, paths);
    }, [props.onExpandedPathsChange, workspaceScope]);
    const expandedPathsRef = React.useRef(expandedPaths);
    expandedPathsRef.current = expandedPaths;

    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;

    const fileQuery = useWorkspaceFileQuery({ scope: workspaceScope, query: searchQuery, enabled: !props.folderPage && machineRpcTargetAvailable, pageSize: UNIVERSAL_SEARCH_PAGE_SIZE, reloadToken: treeReloadNonce, contextKey: props.contextKey });
    const searchResults = fileQuery.items;
    const isSearching = fileQuery.isSearching;

    const folderPage = props.folderPage ?? null;
    const folderPageNavigation = React.useMemo(
        () => (folderPage ? { onOpenFolder: folderPage.onOpenFolder } : null),
        [folderPage?.onOpenFolder],
    );
    const showSearchBar = props.showSearchBar !== false && !folderPage;
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
        const current = expandedPathsRef.current;
        const ancestors = computeExpandedPathsForReveal({ expandedPaths: current, fullPath: path });
        const next = isDirectory && !ancestors.includes(path) ? [...ancestors, path] : ancestors;
        if (props.onExpandedPathsChange) props.onExpandedPathsChange(next);
        else storage.getState().setWorkspaceRepositoryTreeExpandedPaths(workspaceScope, next);
    }, [workspaceScope, props.onExpandedPathsChange, setSearchQuery, revealPath, setShowChangedOnly]);

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


    // The field filters by name in either view; its results stand in place of the tree.
    const shouldShowSearchResults = !folderPage && searchQuery.trim().length > 0;

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
        if (props.onRefreshScm) props.onRefreshScm();
        else if (props.scmSnapshot === undefined && machineRpcTargetAvailable) {
            void workspaceScmController.refresh();
        }
    }, [props.onRefreshScm, props.scmSnapshot, workspaceScmController.refresh, workspaceScope, machineRpcTargetAvailable]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);
    const router = useRouter();
    const accountScope = useActiveServerAccountScope();
    const actionApproval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([accountScope?.serverId, accountScope?.accountId,
            workspaceScope.serverId, workspaceScope.machineId, workspaceScope.rootPath]),
        serverId: workspaceScope.serverId, onExecuted: refresh,
    });

    const allowCreateActions = React.useMemo(() => (
        machineRpcTargetAvailable && Boolean(workspaceScope.machineId.trim() && workspaceScope.rootPath.trim())
    ), [workspaceScope, machineRpcTargetAvailable]);
    const createHostRef = React.useRef({ workspaceScope, folderPath: folderPage?.path, enabled: allowCreateActions });
    createHostRef.current = { workspaceScope, folderPath: folderPage?.path, enabled: allowCreateActions };
    const mounted = React.useRef(true);
    const createRequestRef = React.useRef<AbortController | null>(null);
    // The write a New file / New folder started and has not yet heard back from; a Machine under load
    // can take minutes, and nothing else on screen says it is still going.
    const [pendingCreateSignal, setPendingCreateSignal] = React.useState<AbortSignal | null>(null);
    const [createPromptPending, setCreatePromptPending] = React.useState(false);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    React.useEffect(() => () => {
        createRequestRef.current?.abort();
        createRequestRef.current = null;
    }, [accountScope?.serverId, accountScope?.accountId, workspaceScope, folderPage?.path, allowCreateActions]);
    const captureCreateLifetime = React.useCallback(() => {
        createRequestRef.current?.abort();
        const controller = new AbortController();
        createRequestRef.current = controller;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const host = createHostRef.current;
        return {
            scope: lifetime?.scope,
            signal: controller.signal,
            isCurrent: () => !controller.signal.aborted && mounted.current && (!lifetime || lifetime.isCurrent())
                && createHostRef.current.enabled
                && createHostRef.current.workspaceScope === host.workspaceScope
                && createHostRef.current.folderPath === host.folderPath,
        };
    }, []);
    const webDropState = useWorkspaceRepositoryTreeWebDropState({
        enabled: transferActionsAvailable && Platform.OS === 'web',
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
    });

    const whileCreating = React.useCallback(async <T,>(signal: AbortSignal, write: Promise<T>): Promise<T> => {
        setPendingCreateSignal(signal);
        try {
            return await write;
        } finally {
            if (mounted.current) setPendingCreateSignal((current) => (current === signal ? null : current));
        }
    }, []);
    const requestCreatePath = React.useCallback(async (...args: Parameters<typeof Modal.prompt>) => {
        setCreatePromptPending(true);
        try {
            return await Modal.prompt(...args);
        } finally {
            if (mounted.current) setCreatePromptPending(false);
        }
    }, []);

    const createFile = React.useCallback(() => {
        if (!allowCreateActions) return;
        const lifetime = captureCreateLifetime();
        void (async () => {
            const raw = await requestCreatePath(
                t('files.createFilePromptTitle'),
                t('files.createFilePromptBody'),
                { placeholder: 'src/new-file.ts' },
            );
            if (!lifetime.isCurrent() || typeof raw !== 'string') return;
            const path = raw.trim();
            if (!path) return;
            if (!isSafeWorkspaceRelativePath(path) || path.endsWith('/')) {
                Modal.alert(t('common.error'), t('files.createFileInvalidPath'));
                return;
            }

            const complete = () => {
                if (!lifetime.isCurrent()) return;
                const nextExpanded = computeExpandedPathsForReveal({ expandedPaths: expandedPathsRef.current, fullPath: path });
                setExpandedPaths(nextExpanded);
                refresh();
                revealPath(path);
                (props.onOpenFilePinned ?? props.onOpenFile)(path);
            };
            let res: Awaited<ReturnType<typeof workspaceWriteFile>>;
            try {
                res = await whileCreating(lifetime.signal, workspaceWriteFile(workspaceScope, path, '', null, { signal: lifetime.signal }));
            } catch (error) {
                if (lifetime.isCurrent()) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('files.createFileFailed'));
                return;
            }
            if (!lifetime.isCurrent()) return;
            if (!res.success) {
                if (res.errorCode === 'approval_required' && res.approvalArtifactId) {
                    actionApproval.requestApproval(lifetime.scope && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, workspaceScope.serverId)
                        ? createActionApprovalContinuation<Awaited<ReturnType<typeof workspaceWriteFile>>, 'daemon.filesystem.writeFile'>({
                            artifactId: res.approvalArtifactId, actionId: 'daemon.filesystem.writeFile', scope: lifetime.scope,
                            refreshAfterExecution: false,
                            onFailed: (code, failure) => {
                                if (lifetime.isCurrent()) Modal.alert(t('common.error'), failure?.error || code);
                            },
                            onSucceeded: value => {
                                if (!lifetime.isCurrent()) return;
                                if (value.success) complete();
                                else Modal.alert(t('common.error'), value.error);
                            },
                        }) : res.approvalArtifactId);
                    return;
                }
                Modal.alert(t('common.error'), res.error || t('files.createFileFailed'));
                return;
            }
            complete();
        })();
    }, [captureCreateLifetime, requestCreatePath, whileCreating, actionApproval.requestApproval, allowCreateActions, props.onOpenFile, props.onOpenFilePinned, refresh, setExpandedPaths, workspaceScope, revealPath]);

    const createFolder = React.useCallback((parentDir?: string) => {
        if (!allowCreateActions) return;
        const lifetime = captureCreateLifetime();
        void (async () => {
            const raw = await requestCreatePath(
                t('files.createFolderPromptTitle'),
                t('files.createFolderPromptBody'),
                // From a folder's menu the new folder starts inside it.
                parentDir ? { placeholder: `${parentDir}/new-folder`, defaultValue: `${parentDir}/` } : { placeholder: 'src/new-folder' },
            );
            if (!lifetime.isCurrent() || typeof raw !== 'string') return;
            const directoryPath = raw.trim().replace(/\/+$/, '');
            if (!directoryPath) return;
            if (!isSafeWorkspaceRelativePath(directoryPath)) {
                Modal.alert(t('common.error'), t('files.createFolderInvalidPath'));
                return;
            }

            const complete = () => {
                if (!lifetime.isCurrent()) return;
                const nextExpanded = computeExpandedPathsForReveal({ expandedPaths: expandedPathsRef.current,
                    fullPath: `${directoryPath}/.placeholder` });
                revealPath(directoryPath);
                setExpandedPaths(nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath]);
                refresh();
            };
            const res = await whileCreating(lifetime.signal, workspaceCreateDirectory(workspaceScope, directoryPath));
            if (!lifetime.isCurrent()) return;
            if (!res.success) {
                if (res.errorCode === 'approval_required' && res.approvalArtifactId) {
                    actionApproval.requestApproval(lifetime.scope && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, workspaceScope.serverId)
                        ? createActionApprovalContinuation<Awaited<ReturnType<typeof workspaceCreateDirectory>>, 'daemon.filesystem.createDirectory'>({
                            artifactId: res.approvalArtifactId, actionId: 'daemon.filesystem.createDirectory', scope: lifetime.scope,
                            refreshAfterExecution: false,
                            onFailed: (code, failure) => {
                                if (lifetime.isCurrent()) Modal.alert(t('common.error'), failure?.error || code);
                            },
                            onSucceeded: value => {
                                if (!lifetime.isCurrent()) return;
                                if (value.success) complete();
                                else Modal.alert(t('common.error'), value.error);
                            },
                        }) : res.approvalArtifactId);
                    return;
                }
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            complete();
        })();
    }, [captureCreateLifetime, requestCreatePath, whileCreating, actionApproval.requestApproval, allowCreateActions, refresh, setExpandedPaths, workspaceScope, revealPath]);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });
    const handleRequestDownload = React.useCallback<NonNullable<Parameters<typeof useWorkspaceRepositoryTreeRowActions>[0]['onRequestDownload']>>((params) => transfers.startDownload(params), [transfers.startDownload]);
    const rowActions = useWorkspaceRepositoryTreeRowActions({
        workspaceScope,
        writeActionsEnabled: allowCreateActions,
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        onRequestRefresh: refresh,
        onActionApproval: actionApproval.requestApproval,
        onRequestDownload: handleRequestDownload,
    });

    const startWebUploads = React.useCallback(async (files: readonly File[], destinationDir: string) => {
        const entries: WorkspaceUploadEntry[] = files.map((file) => ({
            kind: 'web',
            file,
            relativePath: file.webkitRelativePath || file.name,
        }));
        // A failed batch settles on the transfer surface in words; no dialog carries its error text.
        await transfers.startUploads({ entries, destinationDir });
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
        // A failed batch settles on the transfer surface in words; no dialog carries its error text.
        await transfers.startUploads({ entries, destinationDir });
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
        const nextDestination = await promptRepositoryUploadDestination(uploadDestinationDir, props.rootLabel);
        if (nextDestination === null) return;
        setUploadDestinationDir(nextDestination);
    }, [uploadDestinationDir, props.rootLabel]);

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
            const destinationDir = readRepositoryFileDropTarget(event)?.destinationDir ?? folderPage?.path ?? '';
            // The browser supplies the concrete DataTransfer at this external boundary.
            const dropped = await readWebDroppedEntries(dataTransfer as DataTransfer);
            const entries: WorkspaceUploadEntry[] = dropped.map((entry) => ({
                kind: 'web',
                file: entry.file,
                relativePath: entry.relativePath,
            }));
            await transfers.startUploads({ entries, destinationDir });
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

    /** Files picked from a folder's menu upload into that folder (lab p-code ACTIONS). */
    const uploadInto = React.useCallback((destinationDir: string) => {
        if (!transferActionsAvailable) return;
        const isCurrent = captureCurrentUploadAcquisition();
        if (!isCurrent()) return;
        if (Platform.OS === 'web') {
            pickedUploadSelectionRef.current = { destinationDir, isCurrent };
            webFileInputRef.current?.click();
            return;
        }
        void startNativeUploads(destinationDir, isCurrent);
    }, [captureCurrentUploadAcquisition, startNativeUploads, transferActionsAvailable]);

    // Row Share items run through the File page's share owner, for the row's path (lab FB1k).
    const fileMenuAccountScope = useActiveServerAccountScope(workspaceScope.serverId);
    const sessionIdForFiles = props.sessionId?.trim() || null;
    const rowShareTarget = React.useMemo<RepositoryTreeRowShareTarget>(() => ({
        workspaceScope,
        actionScope: fileMenuAccountScope,
        linkTarget: props.fileLinkTarget ?? (sessionIdForFiles
            ? { kind: 'session', sessionId: sessionIdForFiles, serverId: workspaceScope.serverId } : null),
        composer: sessionIdForFiles && fileMenuAccountScope ? {
            scope: { serverId: fileMenuAccountScope.serverId, accountId: fileMenuAccountScope.accountId },
            ref: { kind: 'session', sessionId: sessionIdForFiles },
            workspace: workspaceScope,
        } : null,
    }), [fileMenuAccountScope, props.fileLinkTarget, sessionIdForFiles, workspaceScope]);

    const defaultRenderRowActions = React.useCallback<NonNullable<WorkspaceRepositoryTreeBrowserViewProps['renderRowActions']>>((node, control) => {
        if (node.type !== 'file' && node.type !== 'directory') return null;
        const nodeKind: 'file' | 'directory' = node.type === 'file' ? 'file' : 'directory';
        const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
            ? node.sizeBytes
            : null;
        const fileMenuContext = nodeKind === 'file' ? props.buildFileMenuContext?.(node.path) : undefined;
        return (
            <RepositoryTreeRowActionsMenu
                href={node.type === 'file' ? props.fileHref?.(node.path) : null}
                path={node.path}
                kind={nodeKind}
                disableWriteActions={!allowCreateActions}
                downloadActionsEnabled={transferActionsAvailable && (transferSizeBytes == null || transferSizeBytes >= 0)}
                share={rowShareTarget}
                fileMenuContext={nodeKind === 'file' ? { ...fileMenuContext,
                    machineReachable: machineRpcTargetAvailable,
                    open: fileMenuContext?.open ?? (() => handleTreeOpenFile(node.path)),
                } : undefined}
                folderCreation={nodeKind === 'directory' ? { newFolder: allowCreateActions, upload: transferActionsAvailable } : null}
                onSelect={(itemId) => {
                    if (itemId === 'repository-tree-menuitem-new-folder') createFolder(node.path);
                    else if (itemId === 'repository-tree-menuitem-upload') uploadInto(node.path);
                    else void rowActions.onSelectRowMenuItem({ path: node.path, type: nodeKind }, itemId);
                }}
                control={control}
            />
        );
    }, [allowCreateActions, createFolder, handleTreeOpenFile, machineRpcTargetAvailable, props.buildFileMenuContext, props.fileHref, rowActions, rowShareTarget, transferActionsAvailable, uploadInto]);

    // This pane has no header of its own, so its + menu ends the toolbar (the session pane's header carries it).
    const machineName = props.machineName ?? (machine ? getMachineDisplayName(machine).trim() || null : null);
    const createMenuSelectRef = React.useRef(onSelectCreateMenuItem);
    createMenuSelectRef.current = onSelectCreateMenuItem;
    const selectCreateMenuItem = React.useCallback((itemId: RepositoryTreeCreateMenuItemId) => createMenuSelectRef.current(itemId), []);
    const rootLabel = props.rootLabel ?? t('files.projectRoot');
    const unreachableReason = reachability.unreachable ? describeCheckoutUnreachable(reachability) : null;
    const createMenu = React.useMemo(() => (
        <RepositoryTreeCreateMenu
            createEnabled={allowCreateActions}
            createPending={pendingCreateSignal !== null}
            uploadEnabled={transferActionsAvailable}
            isWeb={Platform.OS === 'web'}
            uploadDestinationLabel={uploadDestinationDir || rootLabel}
            unavailableReason={unreachableReason}
            onSelect={selectCreateMenuItem}
        />
    ), [allowCreateActions, pendingCreateSignal, transferActionsAvailable, uploadDestinationDir, rootLabel, unreachableReason, selectCreateMenuItem]);
    const showAllFiles = React.useCallback(() => setShowChangedOnly(false), [setShowChangedOnly]);
    const composed = folderPage && !widget ? folderPage.compose ?? null : null;
    // What is waiting on an approval, named. A composed page carries it in its own bar (no row pushes
    // the page down); every other host shows the sheet row above the tree.
    const openActionApproval = React.useCallback(() => {
        if (!actionApproval.approvalId) return;
        router.push(buildApprovalHref(actionApproval.approvalId, workspaceScope.serverId));
    }, [actionApproval.approvalId, router, workspaceScope.serverId]);
    const approvalNotice = (presentation: 'row' | 'inline') => (
        <ActionApprovalPendingNotice presentation={presentation} message={t('approvals.status.open')}
            summary={actionApproval.approvalSummary} testID="repository-tree-action-approval" onOpenApproval={openActionApproval} />
    );
    const composedControls = composed ? (
        <RepositoryTreeToolbar
            testIDPrefix="workspace-repository-tree"
            layout="inline"
            searchValue=""
            onSearchValueChange={setSearchQuery}
            showSearch={false}
            changedOnly={false}
            changedCount={changedCount}
            onChangedOnlyChange={setShowChangedOnly}
            detailsMode={detailsMode}
            onDetailsModeChange={setDetailsMode}
            onCollapseAll={expandedPaths.length > 0 ? collapseAll : null}
            onRefresh={refresh}
            refreshing={treeRootLoading}
            trailing={createMenu}
            visibility={{ mode: visibilityMode, available: gitIgnoreAvailable, onChange: setVisibilityMode }}
        />
    ) : null;
    // Web composition fits short listings; native recyclers and pane hosts fill their viewport.
    const bodyFill = composed && Platform.OS === 'web' ? COMPOSED_BODY_STYLE : FILL_BODY_STYLE;
    const dropZone = (
        <WebDropTargetView testID="repository-tree-drop-zone" style={bodyFill} {...dropZoneHandlersWithRoot}>
            <View style={[bodyFill, { position: 'relative' }]}>
                {!shouldShowSearchResults ? props.rootHeading : null}
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
                        canLoadMore={fileQuery.canLoadMore}
                        onLoadMore={fileQuery.loadMore}
                        onRetry={fileQuery.retry}
                        onFolderPress={(folder) => handleRevealPath(folder.fullPath.replace(/\/+$/, ''), true)}
                        onFilePress={(file) => props.onOpenFile(file.fullPath)}
                        onFilePressPinned={(file) => (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath)}
                        {...props.scrollProps}
                    />
                ) : null}
                <WorkspaceRepositoryTreeList
                    visible={!shouldShowSearchResults}
                    fileHref={props.fileHref}
                    theme={theme}
                    scope={workspaceScope}
                    directoryListing={machineRpcTargetAvailable}
                    directoryUnavailable={!machineRpcTargetAvailable}
                    reconciliationPaused={props.reconciliationPaused === true || createPromptPending || pendingCreateSignal !== null || rowActions.isRenaming}
                    onRequestRefresh={refresh}
                    reloadToken={treeReloadNonce}
                    detailsMode={detailsMode}
                    visibilityMode={visibilityMode}
                    revealedPaths={revealedPaths}
                    revealRequest={latestRequest}
                    onGitIgnoreAvailableChange={setGitIgnoreAvailable}
                    expandedPaths={expandedPaths}
                    onExpandedPathsChange={setExpandedPaths}
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
                    rootDirectoryPath={folderPage?.path}
                    folderPage={folderPageNavigation}
                    renderRowMetadata={folderPage?.renderRowMetadata}
                    renderRowSubtitle={folderPage?.renderRowSubtitle}
                    onNodesChange={folderPage?.onNodesChange}
                    onVisibleNodesChange={folderPage?.onVisibleNodesChange}
                    listHeader={folderPage?.listHeader}
                    listFooter={folderPage?.listFooter}
                    listEmpty={folderPage?.listEmpty}
                    maxRows={folderPage?.maxRows}
                    emptyLabel={folderPage ? t('projects.code.emptyFolder') : undefined}
                    {...props.scrollProps}
                />
                <RepositoryTreeDropOverlay
                    visible={webDropState.fileDragActive}
                    destinationLabel={webDropState.dropDestinationDir || folderPage?.path || rootLabel}
                />
                {props.scrollOverlay}
            </View>
            <RepositoryTreeTransferStatusBar
                uploadState={transfers.uploadState}
                downloadState={transfers.downloadState}
                machineName={reachability.machineName}
                onCancelUploads={transfers.cancelUploads}
                onDismissUploadFailure={transfers.dismissUploadFailure}
                onCancelDownload={transfers.cancelDownload}
            />
        </WebDropTargetView>
    );

    return (
        <CheckoutReachabilityScope scope={workspaceScope}>
        <View style={{ flex: 1, minHeight: 0 }}>
            {actionApproval.approvalId && !composed ? approvalNotice('row') : null}
            {props.createMenuPlacement === 'paneHeader' ? <BrowserPaneHeader action={createMenu} line={props.paneHeaderLine} /> : null}
            {/* Lab FB1o: the freshness line sits under the pane header, above the toolbar; the tree stays at full strength. */}
            {reachability.unreachable && !reachability.announced
                ? <CheckoutReachabilityLine scope={workspaceScope} testID="repository-tree-offline" /> : null}
            {(showSearchBar || folderPage) && !widget && !composed ? (
                <RepositoryTreeToolbar
                    testIDPrefix={props.createMenuPlacement === 'paneHeader' ? 'repository-tree' : 'workspace-repository-tree'}
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    showSearch={showSearchBar}
                    changedOnly={showChangedOnly}
                    changedCount={changedCount}
                    onChangedOnlyChange={setShowChangedOnly}
                    detailsMode={detailsMode}
                    onDetailsModeChange={setDetailsMode}
                    onCollapseAll={!showChangedOnly && expandedPaths.length > 0 ? collapseAll : null}
                    onRefresh={refresh}
                    refreshing={treeRootLoading}
                    trailing={props.createMenuPlacement === 'paneHeader' ? undefined : createMenu}
                    onRequestClose={props.onRequestClose}
                    onQuickOpen={launchQuickOpen}
                    visibility={{ mode: visibilityMode, available: gitIgnoreAvailable, onChange: setVisibilityMode }}
                />
            ) : null}
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
            {composed ? composed({ controls: composedControls, body: dropZone, status: actionApproval.approvalId ? approvalNotice('inline') : null }) : dropZone}
        </View>
        </CheckoutReachabilityScope>
    );
});
