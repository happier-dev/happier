import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { useFilesystemTreeKeyboard } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { shadowLevelStyle } from '@/shadowElevation';
import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import {
    clearCachedMachineFileBrowserEntries,
    clearCachedMachineFileBrowserRoots,
    getCachedMachineFileBrowserDirectoryMetadata,
    getCachedMachineFileBrowserEntries,
    getCachedMachineFileBrowserRoots,
    listMachineFileBrowserDirectoryEntries,
    listMachineFileBrowserRoots,
    warmMachineFileBrowserDirectoryCache,
    warmMachineFileBrowserRoots,
} from '@/sync/domains/input/machineFileBrowser';
import { workspaceCreateDirectory } from '@/sync/ops/workspaceFileSystem';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { FilesystemBrowserToolbarChrome, type FilesystemBrowserToolbarAction } from '@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome';

import { PATH_BROWSER_CONFIRM_TEST_ID, PATH_BROWSER_CREATE_FOLDER_TEST_ID, PATH_BROWSER_MODAL_TEST_ID, PATH_BROWSER_ROOT_ERROR_TEST_ID } from './pathBrowserTestIds';
import { MachinePathBrowserListRow } from './MachinePathBrowserListRow';
import { PathBrowserModalFooter } from './PathBrowserModalFooter';
import { ManagedWorkspacePreparation, type ManagedWorkspacePreparationRequest, type PreparedManagedWorkspace } from './ManagedWorkspacePreparation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedWorkspaceLocatorV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useMachinePathBrowserCommands } from './useMachinePathBrowserCommands';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { normalizeAbsoluteLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { useManagedMachineName } from '@/components/approvals/approvalReferenceReading';

export type MachinePathBrowserModalProps = CustomModalInjectedProps & Readonly<{
    currentUiContextCommandScope?: string;
    callerContext?: ActionExecutorContext;
    machineId: string;
    workspace?: ManagedWorkspaceLocatorV2;
    /** A workspace with no access yet: the chooser prepares it first, then browses what it settles to. */
    prepare?: ManagedWorkspacePreparationRequest;
    /** The prepared workspace, returned with the picked folder. */
    onPrepared?: (workspace: ManagedWorkspaceLocatorV2) => void;
    serverId?: string | null;
    rootDirectoryPath?: string;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    /** The caller takes the Machine back with the path, so the header offers the Home's other Machines. */
    allowMachineChange?: boolean;
    /** The picked path and the Machine it lives on (the one browsed when it was picked). */
    onResolve: (path: string | null, machineId?: string) => void;
}>;

export type MachinePathBrowserViewProps = Readonly<{
    currentUiContextCommandScope?: string;
    callerContext?: ActionExecutorContext;
    machineId: string;
    workspace?: ManagedWorkspaceLocatorV2;
    serverId?: string | null;
    /**
     * When set, the browser is scoped to this absolute directory and will not list machine roots.
     */
    rootDirectoryPath?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    /**
     * - `modal`: publishes its title band, header action and footer as the shared modal card chrome.
     * - `popover`: renders only the browser body (assumes the parent popover provides the surface).
     */
    variant?: 'modal' | 'popover';
    /**
     * - `confirm`: selection is applied via the footer confirm button.
     * - `immediate`: selecting a compatible node applies selection immediately.
     */
    interaction?: 'confirm' | 'immediate';
    /**
     * Used by popover renderers to cap the view height.
     */
    maxHeight?: number;
    /** Injected by `CustomModal`: the `modal` variant publishes its card chrome through it. */
    setChrome?: CustomModalInjectedProps['setChrome'];
    /** Set when the caller takes another Machine: the header's Machine becomes a chooser. */
    onMachineChange?: (machineId: string) => void;
    onPickPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    headerActionButton: {
        padding: theme.space.s2,
    },
    contextMenu: {
        width: 220,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[5]),
    },
}));

function normalizeAbsolutePath(path: string | null | undefined): string | null {
    const value = String(path ?? '').trim();
    if (!value) return null;
    if (value.startsWith('/')) return value.replace(/\/+$/g, '') || '/';
    if (/^[A-Za-z]:[\\/]/.test(value)) {
        return value.replace(/[\\/]+$/g, '') + (/[A-Za-z]:$/.test(value) ? '\\' : '');
    }
    return null;
}

function joinMachinePath(parentDirectoryPath: string, rawChildPath: string): string {
    const child = String(rawChildPath ?? '').trim();
    if (!child) return parentDirectoryPath;

    const normalizedAbsolute = normalizeAbsolutePath(child);
    if (normalizedAbsolute) return normalizedAbsolute;

    const leadingTrimmedChild = child.replace(/^[\\/]+/g, '');
    const isWindows = /^[A-Za-z]:[\\/]/.test(parentDirectoryPath) || parentDirectoryPath.includes('\\');
    if (isWindows) {
        const parentIsDriveRoot = /^[A-Za-z]:[\\/]?$/.test(parentDirectoryPath);
        if (parentIsDriveRoot) {
            const root = parentDirectoryPath.endsWith('\\') || parentDirectoryPath.endsWith('/')
                ? parentDirectoryPath
                : `${parentDirectoryPath}\\`;
            return normalizeAbsolutePath(`${root}${leadingTrimmedChild}`) ?? `${root}${leadingTrimmedChild}`;
        }
        const base = parentDirectoryPath.replace(/[\\/]+$/g, '');
        return normalizeAbsolutePath(`${base}\\${leadingTrimmedChild}`) ?? `${base}\\${leadingTrimmedChild}`;
    }

    if (parentDirectoryPath === '/') {
        return normalizeAbsolutePath(`/${leadingTrimmedChild}`) ?? `/${leadingTrimmedChild}`;
    }
    const base = parentDirectoryPath.replace(/\/+$/g, '');
    return normalizeAbsolutePath(`${base}/${leadingTrimmedChild}`) ?? `${base}/${leadingTrimmedChild}`;
}

function buildInitialExpandedPaths(path: string | null): string[] {
    if (!path) return [];
    if (path.startsWith('/')) {
        const segments = path.split('/').filter(Boolean);
        const out: string[] = ['/'];
        let current = '';
        for (let index = 0; index < segments.length; index += 1) {
            current = `${current}/${segments[index]}`;
            out.push(current || '/');
        }
        return out;
    }
    const driveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
    if (!driveMatch) return [];
    const root = `${driveMatch[1]}\\`;
    const segments = driveMatch[2].split(/[\\/]+/).filter(Boolean);
    const out: string[] = [root];
    let current = root.replace(/[\\/]$/, '');
    for (let index = 0; index < segments.length; index += 1) {
        current = `${current}\\${segments[index]}`;
        out.push(current);
    }
    return out;
}

function normalizePathPrefixForRelative(root: string): string {
    if (root === '/') return '/';
    const trimmed = root.trim();
    if (!trimmed) return '';
    const isWindows = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\');
    if (isWindows) {
        return trimmed.replace(/[\\/]+$/g, '') + '\\';
    }
    return trimmed.replace(/\/+$/g, '') + '/';
}

function buildInitialExpandedPathsWithinRoot(rootDirectoryPath: string, initialPath: string | null): string[] {
    const root = normalizeAbsolutePath(rootDirectoryPath) ?? null;
    if (!root) return [];
    const initial = normalizeAbsolutePath(initialPath) ?? null;
    if (!initial) return [];
    if (initial === root) return [];

    const rootPrefix = normalizePathPrefixForRelative(root);
    const isWindows = rootPrefix.includes('\\') || /^[A-Za-z]:\\/.test(rootPrefix);
    const initialComparable = isWindows ? initial.toLowerCase() : initial;
    const rootComparable = isWindows ? rootPrefix.toLowerCase() : rootPrefix;
    if (!initialComparable.startsWith(rootComparable)) return [];

    const relative = initial.slice(rootPrefix.length).replace(/^[\\/]+/g, '');
    if (!relative) return [];
    const segments = relative.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) return [];

    const out: string[] = [];
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
        current = joinMachinePath(current, segments[index] ?? '');
        out.push(current);
    }
    return out;
}

/**
 * A typed or pasted absolute path: the folder to list and the start of the name to keep in it
 * (`/var/tmp/pro` → `/var/tmp`, `pro`; `/var/tmp/` → `/var/tmp`, ``). Null for a name search.
 */
function readTypedMachinePath(query: string): Readonly<{ directory: string; prefix: string }> | null {
    const raw = query.trim();
    if (!raw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(raw)) return null;
    const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const directory = normalizeAbsolutePath(raw.slice(0, cut + 1));
    return directory ? { directory, prefix: raw.slice(cut + 1) } : null;
}

function buildInitialSelectionCandidates(path: string | null): string[] {
    return buildInitialExpandedPaths(path).slice().reverse();
}

function getPathBrowserDisplayName(path: string): string {
    const trimmed = String(path ?? '').trim();
    if (!trimmed) return '';
    const segments = trimmed.split(/[\\/]+/).filter(Boolean);
    return segments.at(-1) ?? trimmed;
}

function buildInitialPathPreviewEntries(params: Readonly<{
    directoryPath: string;
    initialExpandedPaths: readonly string[];
}>): Array<{
    name: string;
    path: string;
    type: 'directory';
    source: 'preview';
}> | null {
    const rootPath = params.initialExpandedPaths[0] ?? null;
    if (!rootPath) return null;
    const previewPath = params.directoryPath === ''
        ? rootPath
        : params.directoryPath === rootPath
            ? params.initialExpandedPaths[1] ?? null
            : null;
    if (!previewPath) return null;

    return [{
        name: getPathBrowserDisplayName(previewPath),
        path: previewPath,
        type: 'directory' as const,
        source: 'preview' as const,
    }];
}

function toRootEntries(machineId: string, serverId?: string | null) {
    return (getCachedMachineFileBrowserRoots({ machineId, serverId }) ?? []).map((root) => ({
        name: root.label,
        path: root.path,
        type: 'directory' as const,
    }));
}

export function MachinePathBrowserView(props: MachinePathBrowserViewProps): React.ReactElement {
    const { theme } = useUnistyles();
    const CommandBridge = useCurrentUiContextCommandBridge();
    const folderCaller = React.useMemo(() => new AbortController(), [props.machineId, props.serverId]);
    const browserListRef = React.useRef<VirtualizedListRef | null>(null);
    const lastScrolledSelectionRef = React.useRef<string | null>(null);
    const shouldAutoScrollInitialSelectionRef = React.useRef(false);
    const workspace = props.workspace;
    const rootInput = workspace?.rootPath ?? props.rootDirectoryPath ?? null;
    const rootDirectoryPath = React.useMemo(() => normalizeAbsolutePath(rootInput) ?? '', [rootInput]);
    const usesRootsListing = !workspace && rootDirectoryPath === '';
    const [searchQuery, setSearchQuery] = React.useState('');
    // A workspace chooser picks a folder to work in, so its dot-folders stay out of the way (remote workspaces lab).
    const [showHidden, setShowHidden] = React.useState(() => !workspace);
    const [treeRead, setTreeRead] = React.useState(() => ({ nonce: 0, callerContext: props.callerContext }));
    const [queryRead, setQueryRead] = React.useState(() => ({ nonce: 0, callerContext: props.callerContext }));
    const initialPath = React.useMemo(() => normalizeAbsolutePath(props.initialPath ?? null), [props.initialPath]);
    const includeFiles = props.includeFiles === true || props.selectionMode === 'file';
    const selectionMode = props.selectionMode ?? 'directory';
    const variant = props.variant ?? 'modal';
    const interaction = props.interaction ?? 'confirm';
    // A modal browser always renders inside the shared card: its title band, actions and footer are the
    // card chrome (`useModalCardChrome`), never a header of its own.
    const useCardChrome = variant === 'modal';
    const enableContextMenu = !workspace && variant === 'modal';
    const initialExpandedPaths = React.useMemo(() => (
        usesRootsListing
            ? buildInitialExpandedPaths(initialPath)
            : workspace
                ? [rootDirectoryPath, ...buildInitialExpandedPathsWithinRoot(rootDirectoryPath, initialPath)]
                : buildInitialExpandedPathsWithinRoot(rootDirectoryPath, initialPath)
    ), [initialPath, rootDirectoryPath, usesRootsListing, workspace]);
    // A workspace tree is drawn under its root path as its one root row, open, as a Machine's roots are.
    const workspaceRootEntries = React.useMemo(() => (workspace && rootDirectoryPath !== '' ? [{
        name: rootDirectoryPath, path: rootDirectoryPath, type: 'directory' as const, source: 'remote' as const,
    }] : null), [rootDirectoryPath, workspace]);
    const initialSelectionCandidates = React.useMemo(() => initialExpandedPaths.slice().reverse(), [initialExpandedPaths]);
    const [pickedPath, setSelectedPath] = React.useState<string | null>(null);
    const machineHomeDir = useServerScopedMachine(props.serverId, props.machineId)?.metadata?.homeDir ?? undefined;
    const [expandedPaths, setExpandedPaths] = React.useState<string[]>(() => initialExpandedPaths);
    const shouldAutoSelectInitialPathRef = React.useRef(true);
    const [isCreatingFolder, setIsCreatingFolder] = React.useState(false);
    React.useEffect(() => {
        setIsCreatingFolder(false);
        return () => folderCaller.abort();
    }, [folderCaller]);
    const contextMenuAnchorRef = React.useRef<View | null>(null);
    const contextMenuAnchorsByPath = React.useRef(new Map<string, View>());
    const trackContextMenuAnchor = React.useCallback((path: string, anchor: View | null) => {
        if (anchor) contextMenuAnchorsByPath.current.set(path, anchor);
        else contextMenuAnchorsByPath.current.delete(path);
    }, []);
    const [contextMenuDirectoryPath, setContextMenuDirectoryPath] = React.useState<string | null>(null);
    const inlineLayoutStyle = React.useMemo(() => {
        const maxHeight = typeof props.maxHeight === 'number' && Number.isFinite(props.maxHeight)
            ? Math.max(240, props.maxHeight)
            : undefined;
        return {
            width: '100%',
            maxHeight,
        } as const;
    }, [props.maxHeight]);

    const getCachedEntries = React.useCallback((directoryPath: string) => {
        if (workspace) return directoryPath === '' ? workspaceRootEntries : null;
        if (usesRootsListing) {
            const previewEntries = buildInitialPathPreviewEntries({
                directoryPath,
                initialExpandedPaths,
            });
            if (previewEntries) {
                return previewEntries;
            }
            if (directoryPath === '') {
                return toRootEntries(props.machineId, props.serverId);
            }
        }
        return getCachedMachineFileBrowserEntries({
            machineId: props.machineId,
            serverId: props.serverId,
            directoryPath,
            includeFiles,
        })?.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            sizeBytes: entry.sizeBytes,
            modifiedMs: entry.modifiedMs,
        })) ?? null;
    }, [includeFiles, initialExpandedPaths, props.machineId, props.serverId, usesRootsListing, workspace, workspaceRootEntries]);

    const getCachedDirectoryMetadata = React.useCallback((directoryPath: string) => {
        if (workspace) return directoryPath === '' && workspaceRootEntries ? { truncated: false } : null;
        if (usesRootsListing && directoryPath === '') {
            return { truncated: false };
        }
        return getCachedMachineFileBrowserDirectoryMetadata({
            machineId: props.machineId,
            serverId: props.serverId,
            directoryPath,
            includeFiles,
        });
    }, [includeFiles, props.machineId, props.serverId, usesRootsListing, workspace, workspaceRootEntries]);

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string, signal: AbortSignal, callerContext?: ActionExecutorContext): Promise<LazyDirectoryTreeLoadResult> => {
        if (workspaceRootEntries && directoryPath === '') return { ok: true, entries: workspaceRootEntries };
        if (usesRootsListing && directoryPath === '') {
            const result = await listMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId, signal, callerContext });
            if (!result.ok) return result;
            return {
                ok: true,
                entries: result.roots.map((root) => ({
                    name: root.label,
                    path: root.path,
                    type: 'directory' as const,
                    source: 'remote' as const,
                })),
            };
        }
        const result = await listMachineFileBrowserDirectoryEntries({
            machineId: props.machineId,
            workspace,
            directoryPath,
            includeFiles,
            serverId: props.serverId,
            signal,
            callerContext,
        });
        if (!result.ok) return result;
        return {
            ok: true,
            entries: result.entries.map((entry) => ({
                name: entry.name,
                path: entry.path,
                type: entry.type,
                sizeBytes: entry.sizeBytes,
                modifiedMs: entry.modifiedMs,
                source: 'remote' as const,
            })),
            truncated: result.truncated,
        };
    }, [includeFiles, props.machineId, props.serverId, usesRootsListing, workspace, workspaceRootEntries]);

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string, signal: AbortSignal, callerContext?: ActionExecutorContext): Promise<LazyDirectoryTreeLoadResult> => {
        if (usesRootsListing && directoryPath === '') {
            const result = await warmMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId, signal, callerContext });
            if (!result.ok) return result;
            return {
                ok: true,
                entries: result.roots.map((root) => ({
                    name: root.label,
                    path: root.path,
                    type: 'directory' as const,
                    source: 'remote' as const,
                })),
            };
        }
        const result = await warmMachineFileBrowserDirectoryCache({
            machineId: props.machineId,
            directoryPath,
            includeFiles,
            serverId: props.serverId,
            signal,
            callerContext,
        });
        if (!result.ok) return result;
        return {
            ok: true,
            entries: result.entries.map((entry) => ({
                name: entry.name,
                path: entry.path,
                type: entry.type,
                sizeBytes: entry.sizeBytes,
                modifiedMs: entry.modifiedMs,
                source: 'remote' as const,
            })),
            truncated: result.truncated,
        };
    }, [includeFiles, props.machineId, props.serverId, usesRootsListing]);

    const {
        nodes: rawNodes,
        rootLoaded,
        rootLoading,
        rootError,
        retryRoot,
        retryDirectory,
        toggleDirectory,
    } = useLazyDirectoryTree<ActionExecutorContext>({
        scopeKey: JSON.stringify([props.machineId, props.serverId, workspace?.controller.installationId,
            workspace?.managedId, includeFiles, rootDirectoryPath]),
        enabled: true,
        rootDirectoryPath: usesRootsListing || workspaceRootEntries ? '' : rootDirectoryPath,
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        reloadToken: treeRead.nonce,
        loadContext: treeRead.callerContext,
        getCachedEntries,
        getCachedDirectoryMetadata,
        loadDirectoryEntries,
        ...(workspace ? {} : { warmDirectoryEntries, warmChildDirectoriesLimit: 2 }),
    });

    const canPickLoadedRoot = workspace && rootLoaded && !rootError && selectionMode === 'directory'
        && (!initialPath || initialPath === rootDirectoryPath);
    const selectedPath = pickedPath ?? (canPickLoadedRoot ? rootDirectoryPath : null);
    // The selection is shown once: beside the confirm button when there is one, else under the title.
    let selectedPathLabel: string | null = null;
    if (selectedPath) {
        selectedPathLabel = selectionMode === 'file' && rootDirectoryPath
            ? resolvePathRelativeToRoot({ path: selectedPath, root: rootDirectoryPath, preservePathSpelling: true })
            : formatPathRelativeToHome(selectedPath, workspace ? undefined : machineHomeDir);
    }
    const headerSelectedPathLabel = interaction === 'confirm' ? null : selectedPathLabel;

    const nodesByPath = React.useMemo(() => {
        return new Map(rawNodes.map((node) => [node.path, node] as const));
    }, [rawNodes]);

    const hiddenStateByPath = React.useMemo(() => new Map<string, boolean>(), []);
    const isHiddenByAncestors = React.useCallback((node: FilesystemBrowserNode): boolean => {
        const cached = hiddenStateByPath.get(node.path);
        if (typeof cached === 'boolean') return cached;

        const compute = () => {
            if (node.type === 'file' || node.type === 'directory') {
                if (node.name.startsWith('.')) return true;
            }
            const parentPath = node.parentDirectoryPath;
            if (!parentPath) return false;
            const parent = nodesByPath.get(parentPath);
            if (!parent) return false;
            return isHiddenByAncestors(parent);
        };

        const next = compute();
        hiddenStateByPath.set(node.path, next);
        return next;
    }, [hiddenStateByPath, nodesByPath]);

    const deepSearchRootDirectoryPath = React.useMemo(() => {
        if (rootDirectoryPath !== '') return rootDirectoryPath;
        if (!selectedPath) return '';
        const node = nodesByPath.get(selectedPath);
        if (node?.type === 'directory') return node.path;
        if (node?.type === 'file') return node.parentDirectoryPath ?? '';
        return '';
    }, [nodesByPath, rootDirectoryPath, selectedPath]);

    const typedPath = React.useMemo(() => {
        const parsed = readTypedMachinePath(searchQuery);
        if (!parsed || !rootDirectoryPath) return parsed;
        const directory = normalizeAbsoluteLocalPath(parsed.directory.replace(/\\/g, '/'));
        return resolvePathRelativeToRoot({ path: directory, root: rootDirectoryPath }) === null
            ? null : { ...parsed, directory: normalizeAbsolutePath(directory) ?? directory };
    }, [rootDirectoryPath, searchQuery]);
    const deepSearchEnabled = !workspace && typedPath === null && deepSearchRootDirectoryPath !== '' && searchQuery.trim().length > 0;
    // A typed name in a folder whose listing is capped may sit past the first page: ask the Machine for
    // that name among the folder's children instead of filtering the capped page (QA-BREADTH Q11).
    const typedDirectoryCapped = typedPath !== null && rawNodes.some((node) => node.type === 'info'
        && node.infoKind === 'truncated' && node.parentDirectoryPath === typedPath.directory);
    const typedLookup = !workspace && typedPath !== null && typedPath.prefix !== '' && typedDirectoryCapped ? typedPath : null;
    const enableRowLongPressContextMenu = enableContextMenu && Platform.OS !== 'web';

    const activeServer = useActiveServerSnapshot(props.serverId == null);
    const deepSearchServerId = props.serverId ?? activeServer.serverId;
    // The attached workspace's own name (the Project header chip's owner); null while it resolves.
    const managedName = useManagedMachineName(workspace ? deepSearchServerId ?? null : null, workspace?.managedId ?? null);
    const queryRootDirectoryPath = typedLookup ? typedLookup.directory : deepSearchRootDirectoryPath;
    const deepSearchScope = React.useMemo(() => ({
        machineId: props.machineId, serverId: deepSearchServerId, rootPath: queryRootDirectoryPath,
    }), [props.machineId, deepSearchServerId, queryRootDirectoryPath]);
    const { binding: deepSearchAccountLifetime } = useServerCredentialAccountScopeBinding(deepSearchServerId);
    const deepSearch = useWorkspaceFileQuery({
        scope: deepSearchScope, query: typedLookup ? typedLookup.prefix : searchQuery,
        ...(typedLookup ? { maxDepth: 1 } : {}),
        enabled: (deepSearchEnabled || typedLookup !== null) && deepSearchAccountLifetime?.isCurrent() === true, mode: 'glob',
        accountLifetime: deepSearchAccountLifetime ?? undefined,
        includeHidden: showHidden, resultType: selectionMode === 'file' ? 'file' : 'folder',
        reloadToken: queryRead.nonce,
        callerContext: queryRead.callerContext,
    });
    const deepSearchLoading = deepSearch.isSearching;
    const deepSearchError = deepSearch.error
        ? deepSearch.error.errorCode === 'root_not_found' ? t('errors.workspaceFolderMissing')
            : deepSearch.error.errorCode === 'path_not_allowed' ? t('errors.permissionDenied')
            : deepSearch.error.errorCode === 'target_unavailable' || deepSearch.error.errorCode === 'update_required' ? t('errors.daemonUnavailableBody')
                : t('errors.searchFailed')
        : null;
    const deepSearchNodes = React.useMemo((): FilesystemBrowserNode[] => deepSearch.items.map((item) => {
        const relative = item.fullPath.replace(/\/+$/, '');
        return {
            type: item.fileType === 'file' ? 'file' : 'directory',
            path: joinMachinePath(queryRootDirectoryPath, relative),
            name: item.fileType === 'file' ? relative : item.fileName.replace(/\/+$/, ''),
            depth: 0, isExpanded: false, isLoadingChildren: false,
            parentDirectoryPath: queryRootDirectoryPath, source: 'remote',
        };
    }), [deepSearch.items, queryRootDirectoryPath]);
    // The typed folder's children the Machine found by name, placed in the tree under that folder.
    const typedLookupNodes = React.useMemo((): FilesystemBrowserNode[] => {
        if (!typedLookup) return [];
        const prefix = typedLookup.prefix.toLowerCase();
        const depth = (nodesByPath.get(typedLookup.directory)?.depth ?? 0) + 1;
        return deepSearchNodes.filter((node) => !node.name.includes('/') && node.name.toLowerCase().startsWith(prefix)
            && !nodesByPath.has(node.path)).map((node) => ({ ...node, depth }));
    }, [deepSearchNodes, nodesByPath, typedLookup]);

    const nodes = React.useMemo(() => {
        if (deepSearchEnabled) {
            return deepSearchNodes;
        }
        const q = searchQuery.trim().toLowerCase();
        const base = showHidden
            ? rawNodes
            : rawNodes.filter((node) => {
                if (node.type === 'file' || node.type === 'directory') {
                    return !isHiddenByAncestors(node);
                }
                if (node.parentDirectoryPath) {
                    const parent = nodesByPath.get(node.parentDirectoryPath);
                    return parent ? !isHiddenByAncestors(parent) : true;
                }
                return true;
            });

        if (!q) return base;
        if (typedPath) {
            // The way to the typed folder, then its children whose names start as typed.
            const way = new Set(buildInitialExpandedPaths(typedPath.directory));
            const prefix = typedPath.prefix.toLowerCase();
            const typedNodes = base.filter((node) => (node.type === 'file' || node.type === 'directory')
                ? way.has(node.path) || (node.parentDirectoryPath === typedPath.directory && node.name.toLowerCase().startsWith(prefix))
                : node.parentDirectoryPath !== undefined && node.parentDirectoryPath !== null && way.has(node.parentDirectoryPath));
            return typedLookupNodes.length > 0 ? [...typedNodes, ...typedLookupNodes] : typedNodes;
        }

        const keep = new Set<string>();
        const addChain = (node: FilesystemBrowserNode) => {
            let current: FilesystemBrowserNode | undefined = node;
            while (current) {
                keep.add(current.path);
                if (!current.parentDirectoryPath) break;
                current = nodesByPath.get(current.parentDirectoryPath);
            }
        };

        for (const node of base) {
            if (node.type !== 'file' && node.type !== 'directory') continue;
            if (node.name.toLowerCase().includes(q)) {
                addChain(node);
            }
        }

        return base.filter((node) => {
            if (node.type === 'file' || node.type === 'directory') {
                return keep.has(node.path);
            }
            if (node.parentDirectoryPath) {
                return keep.has(node.parentDirectoryPath);
            }
            return false;
        });
    }, [deepSearchEnabled, deepSearchNodes, isHiddenByAncestors, nodesByPath, rawNodes, searchQuery, showHidden, typedLookupNodes, typedPath]);

    // Typing or pasting a path opens the folders on the way to it, and picks it once it is there.
    React.useEffect(() => {
        if (!typedPath) return;
        const way = usesRootsListing
            ? buildInitialExpandedPaths(typedPath.directory)
            : buildInitialExpandedPathsWithinRoot(rootDirectoryPath, typedPath.directory);
        const expandedWay = workspace ? [rootDirectoryPath, ...way] : way;
        setExpandedPaths((current) => expandedWay.every((path) => current.includes(path)) ? current : [...new Set([...current, ...expandedWay])]);
    }, [rootDirectoryPath, typedPath, usesRootsListing, workspace]);
    const typedTarget = typedPath ? (typedPath.prefix ? joinMachinePath(typedPath.directory, typedPath.prefix) : typedPath.directory) : null;
    const typedTargetNode = typedTarget
        ? nodesByPath.get(typedTarget) ?? typedLookupNodes.find((node) => node.path === typedTarget) : undefined;
    const typedTargetPickable = typedTargetNode !== undefined && typedTargetNode.source !== 'preview'
        && typedTargetNode.type === (selectionMode === 'file' ? 'file' : 'directory');
    React.useEffect(() => {
        if (typedTarget && typedTargetPickable) setSelectedPath(typedTarget);
    }, [typedTarget, typedTargetPickable]);

    const refresh = React.useCallback((callerContext?: ActionExecutorContext) => {
        if (!workspace) {
            clearCachedMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
            clearCachedMachineFileBrowserEntries({ machineId: props.machineId, serverId: props.serverId });
        }
        setTreeRead(previous => ({ nonce: previous.nonce + 1, callerContext }));
        setQueryRead(previous => ({ nonce: previous.nonce + 1, callerContext }));
    }, [props.machineId, props.serverId, workspace]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, []);

    const canClearSearch = searchQuery.trim().length > 0;
    const filterSelected = showHidden !== true;

    React.useEffect(() => {
        shouldAutoSelectInitialPathRef.current = true;
        shouldAutoScrollInitialSelectionRef.current = initialSelectionCandidates.length > 0;
        setSelectedPath(null);
        setExpandedPaths(initialExpandedPaths);
        lastScrolledSelectionRef.current = null;
    }, [initialExpandedPaths, initialSelectionCandidates.length, props.machineId, props.serverId, rootDirectoryPath, usesRootsListing]);

    React.useEffect(() => {
        if (!shouldAutoSelectInitialPathRef.current) return;
        if (initialSelectionCandidates.length === 0) {
            shouldAutoSelectInitialPathRef.current = false;
            setSelectedPath(null);
            return;
        }

        const nodesByPath = new Map(
            nodes
                .filter((node) => node.type === 'directory')
                .map((node) => [node.path, node] as const),
        );
        const visibleCandidates = initialSelectionCandidates.filter((candidate) => nodesByPath.has(candidate));
        const resolvedVisibleCandidates = visibleCandidates.filter((candidate) => nodesByPath.get(candidate)?.source !== 'preview');
        if (resolvedVisibleCandidates.length === 0) {
            return;
        }
        const deepestVisibleCandidate = resolvedVisibleCandidates[0] ?? null;
        if (!deepestVisibleCandidate) return;

        if (deepestVisibleCandidate === initialSelectionCandidates[0]) {
            setSelectedPath(deepestVisibleCandidate);
            shouldAutoSelectInitialPathRef.current = false;
            return;
        }

        const deepestVisibleNode = nodesByPath.get(deepestVisibleCandidate);
        if (deepestVisibleNode?.isLoadingChildren) {
            return;
        }

        const rootCandidate = initialSelectionCandidates[initialSelectionCandidates.length - 1] ?? null;
        if (deepestVisibleCandidate === rootCandidate && initialSelectionCandidates.length > 1) {
            setSelectedPath(null);
            shouldAutoSelectInitialPathRef.current = false;
            return;
        }

        setSelectedPath(deepestVisibleCandidate);
        shouldAutoSelectInitialPathRef.current = false;
    }, [initialSelectionCandidates, nodes]);

    const selectedNodeIndex = React.useMemo(() => {
        if (!selectedPath) return -1;
        const indexByPath = new Map<string, number>();
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (node?.type === 'directory') {
                indexByPath.set(node.path, index);
            }
        }
        return indexByPath.get(selectedPath) ?? -1;
    }, [nodes, selectedPath]);

    const scrollSelectedPathIntoView = React.useCallback((index: number) => {
        if (index < 0) return;
        browserListRef.current?.scrollToIndex({
            index,
            animated: Platform.OS !== 'web',
            viewPosition: 0.35,
        });
    }, []);

    const handleScrollToIndexFailed = React.useCallback((info: { index: number; averageItemLength: number }) => {
        const averageItemLength = Number.isFinite(info.averageItemLength) && info.averageItemLength > 0
            ? info.averageItemLength
            : 56;
        browserListRef.current?.scrollToOffset({
            offset: Math.max(0, averageItemLength * info.index),
            animated: false,
        });
        setTimeout(() => {
            scrollSelectedPathIntoView(info.index);
        }, 0);
    }, [scrollSelectedPathIntoView]);

    React.useEffect(() => {
        if (!selectedPath) {
            lastScrolledSelectionRef.current = null;
            return;
        }
        if (!shouldAutoScrollInitialSelectionRef.current) return;
        if (selectedNodeIndex < 0) return;
        if (lastScrolledSelectionRef.current === selectedPath) return;

        scrollSelectedPathIntoView(selectedNodeIndex);
        lastScrolledSelectionRef.current = selectedPath;
        shouldAutoScrollInitialSelectionRef.current = false;
    }, [scrollSelectedPathIntoView, selectedNodeIndex, selectedPath]);

    const handleClose = React.useCallback(() => {
        props.onRequestClose?.();
    }, [props.onRequestClose]);

    const handleConfirm = React.useCallback(() => {
        if (interaction !== 'confirm') return;
        if (!selectedPath) return;
        props.onPickPath(selectedPath);
    }, [interaction, props.onPickPath, selectedPath]);

    const selectedDirectoryPath = React.useMemo(() => {
        if (!selectedPath) return null;
        const node = nodesByPath.get(selectedPath);
        if (node?.type !== 'directory') return null;
        return node ? node.path : null;
    }, [nodesByPath, selectedPath]);

    const closeContextMenu = React.useCallback(() => {
        setContextMenuDirectoryPath(null);
        contextMenuAnchorRef.current = null;
    }, []);

    const openContextMenu = React.useCallback((directoryPath: string, anchorNode: View | null) => {
        if (!directoryPath) return;
        if (selectionMode !== 'file') {
            setSelectedPath(directoryPath);
        }
        contextMenuAnchorRef.current = anchorNode;
        setContextMenuDirectoryPath(directoryPath);
    }, [selectionMode]);

    const selectPath = React.useCallback((path: string) => {
        shouldAutoSelectInitialPathRef.current = false;
        shouldAutoScrollInitialSelectionRef.current = false;
        setSelectedPath(path);
    }, []);

    const pickPathImmediately = React.useCallback((path: string) => {
        shouldAutoSelectInitialPathRef.current = false;
        shouldAutoScrollInitialSelectionRef.current = false;
        props.onPickPath(path);
    }, [props.onPickPath]);

    const toggleDirectoryPath = React.useCallback((path: string, callerContext?: ActionExecutorContext) => {
        setTreeRead(previous => ({ ...previous, callerContext }));
        void toggleDirectory(path, callerContext);
    }, [toggleDirectory]);

    const revealTreeIndex = React.useCallback((index: number) => {
        browserListRef.current?.scrollToIndex({ index, animated: false });
    }, []);
    const treeKeyboard = useFilesystemTreeKeyboard(nodes, revealTreeIndex);

    const browserRetryRoot = React.useCallback((callerContext?: ActionExecutorContext) => {
        if (deepSearchEnabled) {
            setQueryRead(previous => ({ nonce: previous.nonce + 1, callerContext }));
            return;
        }
        return retryRoot(callerContext);
    }, [deepSearchEnabled, retryRoot]);

    const browserStyle = React.useMemo(() => ({ flex: 1, minHeight: 0 }), []);
    const browserContentContainerStyle = React.useMemo(
        () => ({ paddingVertical: variant === 'modal' ? 16 : 0 }),
        [variant],
    );
    const createFolderInDirectory = React.useCallback(async (directoryPath: string, callerContext?: ActionExecutorContext) => {
        if (!enableContextMenu) return;
        if (!directoryPath) return;
        if (isCreatingFolder) return;
        let confirmingContext = callerContext;
        const raw = await Modal.prompt(
            t('files.createFolderPromptTitle'),
            directoryPath,
            { placeholder: t('promptLibrary.folderPlaceholder'),
                ...(props.currentUiContextCommandScope === undefined ? {} : {
                    commandBridge: CommandBridge,
                    onConfirmContext: (context: ActionExecutorContext) => { confirmingContext = context; },
                }) },
        );
        if (typeof raw !== 'string') return;
        if (folderCaller.signal.aborted) return;
        const trimmed = raw.trim();
        if (!trimmed) return;

        const nextDirectoryPath = joinMachinePath(directoryPath, trimmed);

        try {
            setIsCreatingFolder(true);
            const res = await workspaceCreateDirectory({
                machineId: props.machineId,
                serverId: props.serverId,
                rootPath: directoryPath,
            }, nextDirectoryPath, { signal: folderCaller.signal, callerContext: confirmingContext });
            if (folderCaller.signal.aborted) return;
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'), undefined,
                    props.currentUiContextCommandScope === undefined ? undefined : { commandBridge: CommandBridge });
                return;
            }

            setExpandedPaths((prev) => prev.includes(directoryPath) ? prev : [...prev, directoryPath]);
            clearCachedMachineFileBrowserEntries({ machineId: props.machineId, directoryPath, serverId: props.serverId });
            clearCachedMachineFileBrowserEntries({ machineId: props.machineId, directoryPath: nextDirectoryPath, serverId: props.serverId });
            void retryDirectory(directoryPath, confirmingContext);

            shouldAutoSelectInitialPathRef.current = false;
            shouldAutoScrollInitialSelectionRef.current = true;
            lastScrolledSelectionRef.current = null;
            setSelectedPath(nextDirectoryPath);
            closeContextMenu();
        } catch (error) {
            if (folderCaller.signal.aborted) return;
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('files.createFolderFailed'), undefined,
                props.currentUiContextCommandScope === undefined ? undefined : { commandBridge: CommandBridge });
        } finally {
            if (!folderCaller.signal.aborted) setIsCreatingFolder(false);
        }
    }, [closeContextMenu, enableContextMenu, folderCaller, isCreatingFolder, props.machineId, props.serverId, retryDirectory,
        props.currentUiContextCommandScope, CommandBridge]);

    const effectiveError = deepSearchEnabled ? deepSearchError : rootError;
    const confirmDisabled = !selectedPath || Boolean(effectiveError);
    const canCreateFolder = Boolean(selectedDirectoryPath) && !isCreatingFolder && enableContextMenu;
    const canCollapse = expandedPaths.length > 0;
    const toggleHidden = React.useCallback((callerContext?: ActionExecutorContext) => {
        setQueryRead(previous => ({ ...previous, callerContext }));
        setShowHidden(previous => !previous);
    }, []);
    const search = React.useCallback((value: string, callerContext?: ActionExecutorContext) => {
        setTreeRead(previous => ({ ...previous, callerContext }));
        setQueryRead(previous => ({ ...previous, callerContext }));
        setSearchQuery(value);
    }, []);
    const invokeBrowserCommand = useMachinePathBrowserCommands({
        scope: props.currentUiContextCommandScope, nodes, selectedPath, searchQuery, showHidden, selectionMode, interaction, modal: useCardChrome,
        canConfirm: interaction === 'confirm' && !confirmDisabled, canCreateFolder, canClearSearch,
        canCollapse, contextMenuDirectoryPath,
        rootError: deepSearchEnabled ? deepSearch.error?.errorCode ?? null : rootError,
        searchError: deepSearchEnabled && nodes.length > 0 && !deepSearchLoading && Boolean(deepSearchError),
        onSelectPath: selectPath, onPickPathImmediately: pickPathImmediately, onToggleDirectory: toggleDirectoryPath,
        onOpenContextMenu: path => openContextMenu(path, props.currentUiContextCommandScope === undefined
            ? contextMenuAnchorRef.current : contextMenuAnchorsByPath.current.get(path) ?? null),
        onCloseContextMenu: closeContextMenu,
        onSearch: search, onToggleHidden: toggleHidden, onRefresh: refresh, onCollapseAll: collapseAll,
        onConfirm: handleConfirm, onClose: props.onRequestClose ? handleClose : undefined,
        onCreateFolder: context => { if (selectedDirectoryPath) void createFolderInDirectory(selectedDirectoryPath, context); },
        onContextCreateFolder: context => {
            const directoryPath = contextMenuDirectoryPath;
            if (!directoryPath) return;
            closeContextMenu();
            void createFolderInDirectory(directoryPath, context);
        },
        onRetryRoot: browserRetryRoot, onRetryDirectory: retryDirectory, onRetrySearch: context => {
            setQueryRead(previous => ({ ...previous, callerContext: context }));
            deepSearch.retry();
        },
    });
    const activatePath = React.useCallback((path: string) => invokeBrowserCommand('activate', { path }), [invokeBrowserCommand]);
    const disclosePath = React.useCallback((path: string) => invokeBrowserCommand('disclosure', { path }), [invokeBrowserCommand]);
    const retryPath = React.useCallback((path: string) => invokeBrowserCommand('retryDirectory', { path }), [invokeBrowserCommand]);
    const requestContextMenu = React.useCallback((path: string, anchor: View | null) => {
        contextMenuAnchorRef.current = anchor;
        invokeBrowserCommand('contextMenu', { path });
    }, [invokeBrowserCommand]);
    const renderBrowserRow = React.useCallback(({ node, showDivider }: { node: FilesystemBrowserNode; showDivider: boolean }) => (
        <MachinePathBrowserListRow node={node} showDivider={showDivider}
            selected={selectedPath === node.path && node.type === selectionMode}
            enableContextMenu={enableContextMenu} enableRowLongPressContextMenu={enableRowLongPressContextMenu}
            onToggleDirectory={disclosePath} onOpenContextMenu={requestContextMenu} onRetryDirectory={retryPath}
            onContextMenuAnchorChange={props.currentUiContextCommandScope === undefined ? undefined : trackContextMenuAnchor}
            onActivatePath={activatePath} getTreeRowProps={treeKeyboard.getRowProps} treeActivePath={treeKeyboard.activePath} />
    ), [selectedPath, selectionMode, enableContextMenu, enableRowLongPressContextMenu, disclosePath, requestContextMenu,
        retryPath, activatePath, treeKeyboard.getRowProps, treeKeyboard.activePath, props.currentUiContextCommandScope, trackContextMenuAnchor]);

    const chromeActions = React.useMemo(() => {
        if (!useCardChrome) return null;
        // Where the folder lives is the first fact: the Machine being browsed sits on the title's row, at its
        // trailing end beside the folder action, so it takes no line of its own (the shared header moves both
        // beneath the title on a phone).
        return (
            <>
            {/* New Session's Machine picker as a chip; a browser that cannot move Machines only names it. */}
            <SessionMachineField presentation="chip" testID={`${PATH_BROWSER_MODAL_TEST_ID}.machine`}
                serverId={deepSearchServerId ?? ''} machineId={props.machineId} title={t('newSession.pathPicker.machine')}
                {...(workspace ? { managedName } : {})}
                {...(props.onMachineChange ? { onSelectMachine: (machine: Readonly<{ id: string }>) => props.onMachineChange?.(machine.id) } : {})} />
            {/* A workspace's tree cannot make folders here, so it offers no New folder control. */}
            {workspace ? null : <HappierPressable
                testID={PATH_BROWSER_CREATE_FOLDER_TEST_ID}
                onPress={() => invokeBrowserCommand('createFolder')}
                disabled={!canCreateFolder}
                style={({ pressed }) => ([
                    styles.headerActionButton,
                    { opacity: (!selectedDirectoryPath || isCreatingFolder) ? 0.4 : (pressed ? motionTokens.press.opacity : 1) },
                ])}
                accessibilityRole="button"
                accessibilityLabel={t('files.createFolderA11y')}
            >
                <Icon name="folder" size={16} color={theme.colors.chrome.header.foreground} />
            </HappierPressable>}
            </>
        );
    }, [invokeBrowserCommand, canCreateFolder, isCreatingFolder, props.machineId, props.onMachineChange, deepSearchServerId, selectedDirectoryPath, styles.headerActionButton, theme.colors.chrome.header.foreground, useCardChrome, workspace, managedName]);

    const chromeFooter = React.useMemo(() => {
        if (!useCardChrome || interaction !== 'confirm') return null;
        return (
            <PathBrowserModalFooter label={selectedPathLabel}>
                <RoundButton title={t('common.cancel')} size="normal" display="inverted" onPress={() => invokeBrowserCommand('close')} />
                <RoundButton
                    testID={PATH_BROWSER_CONFIRM_TEST_ID}
                    title={t('common.use')}
                    size="normal"
                    onPress={() => invokeBrowserCommand('confirm')}
                    disabled={confirmDisabled}
                />
            </PathBrowserModalFooter>
        );
    }, [
        interaction,
        selectedPathLabel,
        useCardChrome,
        invokeBrowserCommand,
        confirmDisabled,
    ]);

    const chromeSetter = useCardChrome ? props.setChrome : undefined;
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title ?? (selectionMode === 'file'
            ? t('browserPresence.interaction.chooseFile')
            : t('newSession.pathPicker.enterPathTitle')),
        subtitle: headerSelectedPathLabel ?? undefined,
        testID: PATH_BROWSER_MODAL_TEST_ID,
        actions: chromeActions,
        footer: chromeFooter,
        scrollHost: 'body' as const,
        dimensions: {
            width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
            maxHeightRatio: 0.96,
            size: 'lg' as const,
            viewportMargin: { horizontal: 12, vertical: 12 } as const,
        },
    }), [chromeActions, chromeFooter, headerSelectedPathLabel, props.title, selectionMode]);

    useModalCardChrome(chromeSetter, chrome);

    type ToolbarActionId = 'path-browser-filter' | 'path-browser-refresh';

    type ToolbarActionConfig = Readonly<{
        id: ToolbarActionId;
        priority: number;
        order: number;
        icon: React.ReactNode;
        menuIcon: IconName;
        accessibilityLabel: string;
        disabled?: boolean;
        selected?: boolean;
        onPress: () => void;
    }>;

    const toolbarActions = React.useMemo<ToolbarActionConfig[]>(() => {
        // A workspace chooser only finds a folder: search alone, no file-browser tools (remote workspaces lab).
        if (workspace) return [];
        const actions: ToolbarActionConfig[] = [
            {
                id: 'path-browser-filter',
                priority: 1,
                order: 0,
                icon: (
                    <Icon
                        name="funnel-simple"
                        size={16}
                        color={filterSelected ? theme.colors.text.link : theme.colors.text.secondary}
                    />
                ),
                menuIcon: 'funnel-simple',
                accessibilityLabel: t('files.toolbar.hiddenFiles'),
                selected: filterSelected,
                onPress: () => invokeBrowserCommand('hidden'),
            },
            {
                id: 'path-browser-refresh',
                priority: 0,
                order: 1,
                icon: <Icon name="arrows-clockwise" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'arrow-clockwise',
                accessibilityLabel: t('common.refresh'),
                onPress: () => invokeBrowserCommand('refresh'),
            },
        ];
        // Clearing the query is the search field's own control; the `clearSearch` command keeps its keyboard path.
        return actions;
    }, [filterSelected, invokeBrowserCommand, theme.colors.text.link, theme.colors.text.secondary, workspace]);

    const buildOverflowItems = React.useCallback((hiddenActions: readonly FilesystemBrowserToolbarAction[]) => {
        if (workspace) return [];
        const items: ItemAction[] = [
            {
                id: 'path-browser-collapse-all',
                title: t('files.repositoryCollapseAll'),
                icon: 'arrows-in',
                disabled: !canCollapse,
                onPress: () => invokeBrowserCommand('collapseAll'),
            },
            {
                id: 'path-browser-create-folder',
                title: t('files.createFolderA11y'),
                icon: 'folder',
                disabled: !canCreateFolder,
                onPress: () => invokeBrowserCommand('createFolder'),
            },
        ];

        if (props.onRequestClose) {
            items.push({
                id: 'path-browser-close',
                title: t('common.close'),
                icon: 'x',
                onPress: () => invokeBrowserCommand('close'),
            });
        }

        for (const hiddenAction of hiddenActions) {
            items.push({
                id: hiddenAction.id,
                title: hiddenAction.accessibilityLabel,
                icon: hiddenAction.menuIcon,
                disabled: hiddenAction.disabled,
                onPress: hiddenAction.onPress,
            });
        }

        return items;
    }, [invokeBrowserCommand, canCollapse, canCreateFolder, props.onRequestClose, workspace]);

        return (
            <View
                style={[
                    variant !== 'modal' ? inlineLayoutStyle : null,
                    { flex: 1, minHeight: 0 },
                ]}
            >
            <View style={styles.body}>
                <FilesystemBrowserToolbarChrome
                    currentUiContextCommandScope={props.currentUiContextCommandScope}
                    testID="path-browser-toolbar"
                    searchTestID="path-browser-search"
                    searchPlaceholder={workspace && managedName ? t('files.pane.serverFolderSearch', { workspace: managedName })
                        : t('files.searchPlaceholder')}
                    searchValue={searchQuery}
                    onSearchValueChange={value => invokeBrowserCommand('search', { value })}
                    actions={toolbarActions}
                    buildOverflowItems={buildOverflowItems}
                    overflowTriggerTestID="path-browser-more"
                />

                {(deepSearchEnabled || typedLookup !== null) && nodes.length > 0 ? (
                    deepSearchLoading ? <SurfaceStateCard size="line" kind="loading" title={t('files.searching')} />
                        : deepSearchError ? <SurfaceStateCard testID="path-browser-search-error" size="line" kind="unavailable"
                            title={deepSearchError} action={{ label: t('common.retry'), onPress: async () => { await invokeBrowserCommand('retrySearch'); } }} />
                        : deepSearch.hasMore ? <SurfaceStateCard testID="path-browser-search-incomplete" size="line" kind="warning"
                            title={t('universalSearch.moreResultsAvailable')} /> : null
                ) : null}
                <FilesystemBrowser
                    nodes={nodes}
                    treeRole
                    errorTestID={PATH_BROWSER_ROOT_ERROR_TEST_ID}
                    listHeaderTestID={PATH_BROWSER_ROOT_ERROR_TEST_ID}
                    rootLoading={deepSearchEnabled ? deepSearchLoading : rootLoading}
                    rootError={deepSearchEnabled ? deepSearch.error?.errorCode ?? null : rootError}
                    rootErrorReason={deepSearchEnabled ? deepSearchError : undefined}
                    retryRoot={async () => { await invokeBrowserCommand('retryRoot'); }}
                    loadingLabel={t('common.loading')}
                    loadingLabelCentered={t('common.loading')}
                    inlineRetryLabel={t('common.retry')}
                    emptyLabel={deepSearchEnabled && deepSearch.hasMore ? t('universalSearch.moreResultsAvailable') : t('newSession.pathPicker.emptySuggested')}
                    emptyTestID={deepSearchEnabled && deepSearch.hasMore ? 'path-browser-search-incomplete' : undefined}
                    style={browserStyle}
                    contentContainerStyle={browserContentContainerStyle}
                    listRef={browserListRef}
                    onScrollToIndexFailed={handleScrollToIndexFailed}
                    renderRow={renderBrowserRow}
                    // The virtualized list redraws its rows only when its data or extraData change: the row
                    // renderer changes with the picked folder and the keyboard's active row, so a pick shows at once.
                    extraData={renderBrowserRow}
                />
                <DropdownMenu
                    open={enableContextMenu && contextMenuDirectoryPath != null}
                    onOpenChange={(next) => {
                        if (!next) invokeBrowserCommand('closeContextMenu');
                    }}
                    trigger={null}
                    popoverAnchorRef={contextMenuAnchorRef as React.RefObject<any>}
                    popoverPortalWebTarget="body"
                    placement="bottom"
                    gap={6}
                    matchTriggerWidth={false}
                    overlayStyle={styles.contextMenu as any}
                    resultsPaddingBottom={0}
                    rowKind="item"
                    itemRowProps={{ density: 'compact' }}
                    allowEmptySelection={true}
                    closeOnSelect={false}
                    items={[{
                        id: 'create-folder',
                        title: t('files.createFolderA11y'),
                        icon: <Icon name="folder" size={16} color={theme.colors.text.primary} />,
                    }]}
                    onSelect={(itemId) => {
                        if (itemId !== 'create-folder') return;
                        invokeBrowserCommand('contextCreateFolder');
                    }}
                />
            </View>

        </View>
    );
}

export function MachinePathBrowserModal(props: MachinePathBrowserModalProps): React.ReactElement {
    // The Machine being browsed; it changes only for a caller that takes the Machine back.
    const [selectedMachineId, setMachineId] = React.useState(props.machineId);
    const [prepared, setPrepared] = React.useState<ManagedWorkspaceLocatorV2 | null>(null);
    const onPrepared = props.onPrepared;
    const handlePrepared = React.useCallback((workspace: PreparedManagedWorkspace) => {
        const locator: ManagedWorkspaceLocatorV2 = { v: 2, kind: 'managed', ...workspace };
        onPrepared?.(locator);
        setPrepared(locator);
    }, [onPrepared]);
    const workspace = props.workspace ?? prepared ?? undefined;
    const machineId = workspace?.controller.machineId ?? selectedMachineId;
    const handlePickPath = React.useCallback((path: string) => {
        props.onResolve(path, machineId);
        props.onClose();
    }, [machineId, props.onClose, props.onResolve]);

    const handleRequestClose = React.useCallback(() => {
        props.onResolve(null);
        props.onClose();
    }, [props.onClose, props.onResolve]);

    if (props.prepare && !workspace) {
        return <ManagedWorkspacePreparation request={props.prepare} title={props.title ?? t('files.pane.serverFolderTitle')}
            setChrome={props.setChrome} onPrepared={handlePrepared} onCancel={handleRequestClose} />;
    }
    return (
        <MachinePathBrowserView
            // Another Machine is another tree: its listing, selection and search start over.
            key={machineId}
            currentUiContextCommandScope={props.currentUiContextCommandScope}
            callerContext={props.callerContext}
            machineId={machineId}
            workspace={workspace}
            onMachineChange={!workspace && props.allowMachineChange ? setMachineId : undefined}
            serverId={workspace?.serverId ?? props.serverId}
            rootDirectoryPath={props.rootDirectoryPath}
            title={props.title}
            initialPath={props.initialPath}
            includeFiles={props.includeFiles}
            selectionMode={props.selectionMode}
            variant="modal"
            interaction="confirm"
            setChrome={props.setChrome}
            onPickPath={handlePickPath}
            onRequestClose={handleRequestClose}
        />
    );
}
