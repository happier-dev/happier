import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { useFilesystemTreeKeyboard } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
import { machineCreateDirectory } from '@/sync/ops/machines';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { FilesystemBrowserToolbarChrome, type FilesystemBrowserToolbarAction } from '@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome';

import { PATH_BROWSER_CONFIRM_TEST_ID, PATH_BROWSER_CREATE_FOLDER_TEST_ID, PATH_BROWSER_MODAL_TEST_ID } from './pathBrowserTestIds';
import { MachinePathBrowserListRow } from './MachinePathBrowserListRow';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

export type MachinePathBrowserModalProps = CustomModalInjectedProps & Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    onResolve: (path: string | null) => void;
}>;

export type MachinePathBrowserViewProps = Readonly<{
    machineId: string;
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
    onPickPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    selectionText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    headerActionButton: {
        padding: 2,
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
    const browserListRef = React.useRef<VirtualizedListRef | null>(null);
    const lastScrolledSelectionRef = React.useRef<string | null>(null);
    const shouldAutoScrollInitialSelectionRef = React.useRef(false);
    const rootDirectoryPath = React.useMemo(() => normalizeAbsolutePath(props.rootDirectoryPath ?? null) ?? '', [props.rootDirectoryPath]);
    const usesRootsListing = rootDirectoryPath === '';
    const [searchQuery, setSearchQuery] = React.useState('');
    const [showHidden, setShowHidden] = React.useState(true);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [deepSearchReloadNonce, setDeepSearchReloadNonce] = React.useState(0);
    const initialPath = React.useMemo(() => normalizeAbsolutePath(props.initialPath ?? null), [props.initialPath]);
    const includeFiles = props.includeFiles === true || props.selectionMode === 'file';
    const selectionMode = props.selectionMode ?? 'directory';
    const variant = props.variant ?? 'modal';
    const interaction = props.interaction ?? 'confirm';
    // A modal browser always renders inside the shared card: its title band, actions and footer are the
    // card chrome (`useModalCardChrome`), never a header of its own.
    const useCardChrome = variant === 'modal';
    const enableContextMenu = variant === 'modal';
    const initialExpandedPaths = React.useMemo(() => (
        usesRootsListing
            ? buildInitialExpandedPaths(initialPath)
            : buildInitialExpandedPathsWithinRoot(rootDirectoryPath, initialPath)
    ), [initialPath, rootDirectoryPath, usesRootsListing]);
    const initialSelectionCandidates = React.useMemo(() => initialExpandedPaths.slice().reverse(), [initialExpandedPaths]);
    const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
    const machineHomeDir = useServerScopedMachine(props.serverId, props.machineId)?.metadata?.homeDir ?? undefined;
    // The selection is shown once: beside the confirm button when there is one, else under the title.
    const selectedPathLabel = selectedPath ? formatPathRelativeToHome(selectedPath, machineHomeDir) : null;
    const headerSelectedPathLabel = interaction === 'confirm' ? null : selectedPathLabel;
    const [expandedPaths, setExpandedPaths] = React.useState<string[]>(() => initialExpandedPaths);
    const shouldAutoSelectInitialPathRef = React.useRef(true);
    const [isCreatingFolder, setIsCreatingFolder] = React.useState(false);
    const contextMenuAnchorRef = React.useRef<View | null>(null);
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
    }, [includeFiles, initialExpandedPaths, props.machineId, props.serverId, usesRootsListing]);

    const getCachedDirectoryMetadata = React.useCallback((directoryPath: string) => {
        if (usesRootsListing && directoryPath === '') {
            return { truncated: false };
        }
        return getCachedMachineFileBrowserDirectoryMetadata({
            machineId: props.machineId,
            serverId: props.serverId,
            directoryPath,
            includeFiles,
        });
    }, [includeFiles, props.machineId, props.serverId, usesRootsListing]);

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string): Promise<LazyDirectoryTreeLoadResult> => {
        if (usesRootsListing && directoryPath === '') {
            const result = await listMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
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
            directoryPath,
            includeFiles,
            serverId: props.serverId,
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

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string): Promise<LazyDirectoryTreeLoadResult> => {
        if (usesRootsListing && directoryPath === '') {
            const result = await warmMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
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
        rootLoading,
        rootError,
        retryRoot,
        retryDirectory,
        toggleDirectory,
    } = useLazyDirectoryTree({
        scopeKey: `${props.machineId}:${props.serverId ?? ''}:${includeFiles ? 'all' : 'dirs'}:${rootDirectoryPath}`,
        enabled: true,
        rootDirectoryPath: usesRootsListing ? '' : rootDirectoryPath,
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        reloadToken: treeReloadNonce,
        getCachedEntries,
        getCachedDirectoryMetadata,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit: 2,
    });

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

    const deepSearchEnabled = deepSearchRootDirectoryPath !== '' && searchQuery.trim().length > 0;
    const enableRowLongPressContextMenu = enableContextMenu && Platform.OS !== 'web';

    const activeServer = useActiveServerSnapshot(props.serverId == null);
    const deepSearchServerId = props.serverId ?? activeServer.serverId;
    const deepSearchScope = React.useMemo(() => ({
        machineId: props.machineId, serverId: deepSearchServerId, rootPath: deepSearchRootDirectoryPath,
    }), [props.machineId, deepSearchServerId, deepSearchRootDirectoryPath]);
    const { binding: deepSearchAccountLifetime } = useServerCredentialAccountScopeBinding(deepSearchServerId);
    const deepSearch = useWorkspaceFileQuery({
        scope: deepSearchScope, query: searchQuery,
        enabled: deepSearchEnabled && deepSearchAccountLifetime?.isCurrent() === true, mode: 'glob',
        accountLifetime: deepSearchAccountLifetime ?? undefined,
        includeHidden: showHidden, resultType: selectionMode === 'file' ? 'file' : 'folder',
        reloadToken: deepSearchReloadNonce,
    });
    const deepSearchLoading = deepSearch.isSearching;
    const deepSearchError = deepSearch.error
        ? deepSearch.error.errorCode === 'path_not_allowed' ? t('errors.permissionDenied')
            : deepSearch.error.errorCode === 'method_unavailable' ? t('errors.daemonUnavailableBody')
                : t('errors.searchFailed')
        : null;
    const deepSearchNodes = React.useMemo((): FilesystemBrowserNode[] => deepSearch.items.map((item) => {
        const relative = item.fullPath.replace(/\/+$/, '');
        return {
            type: item.fileType === 'file' ? 'file' : 'directory',
            path: joinMachinePath(deepSearchRootDirectoryPath, relative),
            name: item.fileType === 'file' ? relative : item.fileName.replace(/\/+$/, ''),
            depth: 0, isExpanded: false, isLoadingChildren: false,
            parentDirectoryPath: deepSearchRootDirectoryPath, source: 'remote',
        };
    }), [deepSearch.items, deepSearchRootDirectoryPath]);

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
    }, [deepSearchEnabled, deepSearchNodes, isHiddenByAncestors, nodesByPath, rawNodes, searchQuery, showHidden]);

    const refresh = React.useCallback(() => {
        clearCachedMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
        clearCachedMachineFileBrowserEntries({ machineId: props.machineId, serverId: props.serverId });
        setTreeReloadNonce((n) => n + 1);
        setDeepSearchReloadNonce((n) => n + 1);
        void retryRoot();
    }, [props.machineId, props.serverId, retryRoot]);

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

    const toggleDirectoryPath = React.useCallback((path: string) => {
        void toggleDirectory(path);
    }, [toggleDirectory]);

    const revealTreeIndex = React.useCallback((index: number) => {
        browserListRef.current?.scrollToIndex({ index, animated: false });
    }, []);
    const treeKeyboard = useFilesystemTreeKeyboard(nodes, revealTreeIndex);

    const browserRetryRoot = React.useCallback(() => {
        if (deepSearchEnabled) {
            setDeepSearchReloadNonce((n) => n + 1);
            return;
        }
        return retryRoot();
    }, [deepSearchEnabled, retryRoot]);

    const browserStyle = React.useMemo(() => ({ flex: 1, minHeight: 0 }), []);
    const browserContentContainerStyle = React.useMemo(
        () => ({ paddingVertical: variant === 'modal' ? 16 : 0 }),
        [variant],
    );
    const renderBrowserRow = React.useCallback(({ node, showDivider }: { node: FilesystemBrowserNode; showDivider: boolean }) => (
        <MachinePathBrowserListRow
            node={node}
            showDivider={showDivider}
            selected={
                selectedPath === node.path
                    && (selectionMode === 'file' ? node.type === 'file' : node.type === 'directory')
            }
            selectionMode={selectionMode}
            interaction={interaction}
            enableContextMenu={enableContextMenu}
            enableRowLongPressContextMenu={enableRowLongPressContextMenu}
            onToggleDirectory={toggleDirectoryPath}
            onOpenContextMenu={openContextMenu}
            onRetryDirectory={retryDirectory}
            onSelectPath={selectPath}
            onPickPathImmediately={pickPathImmediately}
            getTreeRowProps={treeKeyboard.getRowProps}
        />
    ), [
        enableContextMenu,
        enableRowLongPressContextMenu,
        interaction,
        openContextMenu,
        pickPathImmediately,
        retryDirectory,
        selectPath,
        selectedPath,
        selectionMode,
        toggleDirectoryPath,
        treeKeyboard.getRowProps,
    ]);

    const createFolderInDirectory = React.useCallback(async (directoryPath: string) => {
        if (!enableContextMenu) return;
        if (!directoryPath) return;
        if (isCreatingFolder) return;
        const raw = await Modal.prompt(
            t('files.createFolderPromptTitle'),
            directoryPath,
            { placeholder: t('promptLibrary.folderPlaceholder') },
        );
        if (typeof raw !== 'string') return;
        const trimmed = raw.trim();
        if (!trimmed) return;

        const nextDirectoryPath = joinMachinePath(directoryPath, trimmed);

        try {
            setIsCreatingFolder(true);
            const res = await machineCreateDirectory(props.machineId, nextDirectoryPath, { serverId: props.serverId });
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            setExpandedPaths((prev) => prev.includes(directoryPath) ? prev : [...prev, directoryPath]);
            clearCachedMachineFileBrowserEntries({ machineId: props.machineId, directoryPath, serverId: props.serverId });
            clearCachedMachineFileBrowserEntries({ machineId: props.machineId, directoryPath: nextDirectoryPath, serverId: props.serverId });
            void retryDirectory(directoryPath);

            shouldAutoSelectInitialPathRef.current = false;
            shouldAutoScrollInitialSelectionRef.current = true;
            lastScrolledSelectionRef.current = null;
            setSelectedPath(nextDirectoryPath);
            closeContextMenu();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('files.createFolderFailed'));
        } finally {
            setIsCreatingFolder(false);
        }
    }, [closeContextMenu, enableContextMenu, isCreatingFolder, props.machineId, props.serverId, retryDirectory]);

    const chromeActions = React.useMemo(() => {
        if (!useCardChrome) return null;
        return (
            <Pressable
                testID={PATH_BROWSER_CREATE_FOLDER_TEST_ID}
                onPress={() => {
                    if (!selectedDirectoryPath) return;
                    void createFolderInDirectory(selectedDirectoryPath);
                }}
                disabled={!selectedDirectoryPath || isCreatingFolder}
                hitSlop={10}
                style={({ pressed }) => ([
                    styles.headerActionButton,
                    { opacity: (!selectedDirectoryPath || isCreatingFolder) ? 0.4 : (pressed ? motionTokens.press.opacity : 1) },
                ])}
                accessibilityRole="button"
                accessibilityLabel={t('files.createFolderA11y')}
            >
                <Icon name="folder" size={16} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [createFolderInDirectory, isCreatingFolder, selectedDirectoryPath, styles.headerActionButton, theme.colors.chrome.header.foreground, useCardChrome]);

    const chromeFooter = React.useMemo(() => {
        if (!useCardChrome || interaction !== 'confirm') return null;
        const effectiveError = deepSearchEnabled ? deepSearchError : rootError;
        const confirmDisabled = !selectedPath || Boolean(effectiveError);
        return (
            <View style={styles.footer}>
                <Text numberOfLines={1} style={styles.selectionText}>
                    {selectedPathLabel ?? ''}
                </Text>
                <RoundButton title={t('common.cancel')} size="normal" display="inverted" onPress={handleClose} />
                <RoundButton
                    testID={PATH_BROWSER_CONFIRM_TEST_ID}
                    title={t('common.use')}
                    size="normal"
                    onPress={handleConfirm}
                    disabled={confirmDisabled}
                />
            </View>
        );
    }, [
        deepSearchEnabled,
        deepSearchError,
        handleClose,
        handleConfirm,
        interaction,
        rootError,
        selectedPath,
        selectedPathLabel,
        styles.footer,
        styles.selectionText,
        useCardChrome,
    ]);

    const chromeSetter = useCardChrome ? props.setChrome : undefined;
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title ?? t('newSession.pathPicker.enterPathTitle'),
        subtitle: headerSelectedPathLabel ?? undefined,
        testID: PATH_BROWSER_MODAL_TEST_ID,
        actions: chromeActions,
        footer: chromeFooter,
        scrollHost: 'body' as const,
        dimensions: {
            width: 560,
            maxHeightRatio: 0.96,
            size: 'lg' as const,
            viewportMargin: { horizontal: 12, vertical: 12 } as const,
        },
    }), [chromeActions, chromeFooter, headerSelectedPathLabel, props.title]);

    useModalCardChrome(chromeSetter, chrome);

    type ToolbarActionId = 'path-browser-filter' | 'path-browser-refresh' | 'path-browser-clear-search';

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
                onPress: () => setShowHidden((prev) => !prev),
            },
            {
                id: 'path-browser-refresh',
                priority: 0,
                order: 1,
                icon: <Icon name="arrows-clockwise" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'arrow-clockwise',
                accessibilityLabel: t('common.refresh'),
                onPress: refresh,
            },
        ];

        if (canClearSearch) {
            actions.push({
                id: 'path-browser-clear-search',
                priority: 2,
                order: 2,
                icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'x',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            });
        }

        return actions;
    }, [canClearSearch, filterSelected, refresh, theme.colors.text.link, theme.colors.text.secondary]);

    const buildOverflowItems = React.useCallback((hiddenActions: readonly FilesystemBrowserToolbarAction[]) => {
        const items: ItemAction[] = [
            {
                id: 'path-browser-collapse-all',
                title: t('files.repositoryCollapseAll'),
                icon: 'arrows-in',
                disabled: expandedPaths.length === 0,
                onPress: collapseAll,
            },
            {
                id: 'path-browser-create-folder',
                title: t('files.createFolderA11y'),
                icon: 'folder',
                disabled: !selectedDirectoryPath || isCreatingFolder,
                onPress: () => {
                    if (!selectedDirectoryPath) return;
                    void createFolderInDirectory(selectedDirectoryPath);
                },
            },
        ];

        if (props.onRequestClose) {
            items.push({
                id: 'path-browser-close',
                title: t('common.close'),
                icon: 'x',
                onPress: () => props.onRequestClose?.(),
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
    }, [collapseAll, createFolderInDirectory, expandedPaths.length, isCreatingFolder, props.onRequestClose, selectedDirectoryPath]);

        return (
            <View
                style={[
                    variant !== 'modal' ? inlineLayoutStyle : null,
                    { flex: 1, minHeight: 0 },
                ]}
            >
            <View style={styles.body}>
                <FilesystemBrowserToolbarChrome
                    testID="path-browser-toolbar"
                    searchTestID="path-browser-search"
                    searchPlaceholder={t('files.searchPlaceholder')}
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    actions={toolbarActions}
                    buildOverflowItems={buildOverflowItems}
                    overflowTriggerTestID="path-browser-more"
                />

                {deepSearchEnabled && nodes.length > 0 ? (
                    deepSearchLoading ? <SurfaceStateCard size="line" kind="loading" title={t('files.searching')} />
                        : deepSearchError ? <SurfaceStateCard testID="path-browser-search-error" size="line" kind="unavailable"
                            title={deepSearchError} action={{ label: t('common.retry'), onPress: deepSearch.retry }} />
                        : deepSearch.hasMore ? <SurfaceStateCard testID="path-browser-search-incomplete" size="line" kind="warning"
                            title={t('universalSearch.moreResultsAvailable')} /> : null
                ) : null}
                <FilesystemBrowser
                    nodes={nodes}
                    treeRole
                    extraData={treeKeyboard.activePath}
                    rootLoading={deepSearchEnabled ? deepSearchLoading : rootLoading}
                    rootError={deepSearchEnabled ? deepSearch.error?.errorCode ?? null : rootError}
                    rootErrorReason={deepSearchEnabled ? deepSearchError : undefined}
                    retryRoot={browserRetryRoot}
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
                />
                <DropdownMenu
                    open={enableContextMenu && contextMenuDirectoryPath != null}
                    onOpenChange={(next) => {
                        if (!next) closeContextMenu();
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
                    items={[{
                        id: 'create-folder',
                        title: t('files.createFolderA11y'),
                        icon: <Icon name="folder" size={16} color={theme.colors.text.primary} />,
                    }]}
                    onSelect={(itemId) => {
                        const directoryPath = contextMenuDirectoryPath;
                        if (!directoryPath) return;
                        if (itemId !== 'create-folder') return;
                        closeContextMenu();
                        void createFolderInDirectory(directoryPath);
                    }}
                />
            </View>

        </View>
    );
}

export function MachinePathBrowserModal(props: MachinePathBrowserModalProps): React.ReactElement {
    const handlePickPath = React.useCallback((path: string) => {
        props.onResolve(path);
        props.onClose();
    }, [props.onClose, props.onResolve]);

    const handleRequestClose = React.useCallback(() => {
        props.onResolve(null);
        props.onClose();
    }, [props.onClose, props.onResolve]);

    return (
        <MachinePathBrowserView
            machineId={props.machineId}
            serverId={props.serverId}
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
