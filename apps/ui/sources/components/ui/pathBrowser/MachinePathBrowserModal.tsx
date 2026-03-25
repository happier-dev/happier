import * as React from 'react';
import { FlatList, Platform, Pressable, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal, type CustomModalInjectedProps } from '@/modal';
import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
import { machineRipgrep } from '@/sync/ops/machineRipgrep';
import { t } from '@/text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
    FileBrowserToolbar,
    FileBrowserToolbarIconButton,
    resolveVisibleFileBrowserToolbarActionIds,
} from '@/components/ui/filesystemBrowser/FileBrowserToolbar';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import {
    getPathBrowserRowTestId,
    getPathBrowserToggleTestId,
    PATH_BROWSER_CONFIRM_TEST_ID,
    PATH_BROWSER_CREATE_FOLDER_TEST_ID,
    PATH_BROWSER_MODAL_TEST_ID,
} from './pathBrowserTestIds';

export type MachinePathBrowserModalProps = CustomModalInjectedProps & Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    onResolve: (path: string | null) => void;
    onRequestClose?: () => void;
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
     * - `modal`: renders header + footer and a self-contained card surface.
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
    onPickPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

function stopToggleEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    selectionText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    directoryIconWrap: {
        width: 18,
        height: 18,
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    directoryToggle: {
        position: 'absolute',
        left: -18,
        top: 1,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    headerActionButton: {
        padding: 2,
    },
    contextMenu: {
        width: 220,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.18,
        shadowRadius: 6,
        elevation: 6,
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
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const browserListRef = React.useRef<FlatList<FilesystemBrowserNode> | null>(null);
    const lastScrolledSelectionRef = React.useRef<string | null>(null);
    const shouldAutoScrollInitialSelectionRef = React.useRef(false);
    const rootDirectoryPath = React.useMemo(() => normalizeAbsolutePath(props.rootDirectoryPath ?? null) ?? '', [props.rootDirectoryPath]);
    const usesRootsListing = rootDirectoryPath === '';
    const [searchQuery, setSearchQuery] = React.useState('');
    const [showHidden, setShowHidden] = React.useState(true);
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [deepSearchReloadNonce, setDeepSearchReloadNonce] = React.useState(0);
    const [deepSearchNodes, setDeepSearchNodes] = React.useState<FilesystemBrowserNode[] | null>(null);
    const [deepSearchLoading, setDeepSearchLoading] = React.useState(false);
    const [deepSearchError, setDeepSearchError] = React.useState<string | null>(null);
    const initialPath = React.useMemo(() => normalizeAbsolutePath(props.initialPath ?? null), [props.initialPath]);
    const includeFiles = props.includeFiles === true || props.selectionMode === 'file';
    const selectionMode = props.selectionMode ?? 'directory';
    const variant = props.variant ?? 'modal';
    const interaction = props.interaction ?? 'confirm';
    const enableContextMenu = variant === 'modal';
    const initialExpandedPaths = React.useMemo(() => (
        usesRootsListing
            ? buildInitialExpandedPaths(initialPath)
            : buildInitialExpandedPathsWithinRoot(rootDirectoryPath, initialPath)
    ), [initialPath, rootDirectoryPath, usesRootsListing]);
    const initialSelectionCandidates = React.useMemo(() => initialExpandedPaths.slice().reverse(), [initialExpandedPaths]);
    const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = React.useState<string[]>(() => initialExpandedPaths);
    const shouldAutoSelectInitialPathRef = React.useRef(true);
    const [isCreatingFolder, setIsCreatingFolder] = React.useState(false);
    const contextMenuAnchorRef = React.useRef<View | null>(null);
    const [contextMenuDirectoryPath, setContextMenuDirectoryPath] = React.useState<string | null>(null);
    const modalLayoutStyle = React.useMemo(() => {
        if (variant !== 'modal') {
            const maxHeight = typeof props.maxHeight === 'number' && Number.isFinite(props.maxHeight)
                ? Math.max(240, props.maxHeight)
                : undefined;
            return {
                width: '100%',
                maxHeight,
            } as const;
        }
        const horizontalMargin = 24;
        const verticalMargin = 24;
        const maxWidth = Math.max(280, windowWidth - horizontalMargin * 2);
        const width = Math.min(560, maxWidth);
        const maxHeight = Math.max(320, windowHeight - verticalMargin * 2);

        return {
            width,
            maxWidth,
            maxHeight,
        } as const;
    }, [props.maxHeight, variant, windowHeight, windowWidth]);

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

    React.useEffect(() => {
        if (!deepSearchEnabled) {
            setDeepSearchNodes(null);
            setDeepSearchLoading(false);
            setDeepSearchError(null);
            return;
        }

        const trimmedQuery = searchQuery.trim();
        if (!trimmedQuery) {
            setDeepSearchNodes(null);
            setDeepSearchLoading(false);
            setDeepSearchError(null);
            return;
        }

        let cancelled = false;
        setDeepSearchLoading(true);
        setDeepSearchError(null);

        const DEEP_SEARCH_DEBOUNCE_MS = 200;
        const handle = setTimeout(() => {
            void (async () => {
                const args: string[] = ['--files', '--iglob', `*${trimmedQuery}*`];
                if (showHidden) {
                    args.push('--hidden');
                }

                const result = await machineRipgrep(
                    props.machineId,
                    args,
                    deepSearchRootDirectoryPath,
                    { serverId: props.serverId },
                );
                if (cancelled) return;

                if (!result.success) {
                    setDeepSearchNodes([]);
                    setDeepSearchError(result.error ?? t('errors.unknownError'));
                    setDeepSearchLoading(false);
                    return;
                }

                const stdout = typeof result.stdout === 'string' ? result.stdout : '';
                const lines = stdout
                    .split(/\r?\n/g)
                    .map((line) => line.trim())
                    .filter(Boolean);

                const absoluteFiles = lines.map((relative) => joinMachinePath(deepSearchRootDirectoryPath, relative));
                const fileNodes: FilesystemBrowserNode[] = absoluteFiles.map((absPath, index) => ({
                    type: 'file',
                    path: absPath,
                    name: lines[index] ?? getPathBrowserDisplayName(absPath),
                    depth: 0,
                    isExpanded: false,
                    isLoadingChildren: false,
                    parentDirectoryPath: deepSearchRootDirectoryPath,
                    source: 'remote' as const,
                }));

                if (selectionMode === 'file') {
                    setDeepSearchNodes(fileNodes);
                    setDeepSearchLoading(false);
                    return;
                }

                const directoryPaths = new Set<string>();
                directoryPaths.add(deepSearchRootDirectoryPath);
                for (const absPath of absoluteFiles) {
                    const relative = absPath.slice(deepSearchRootDirectoryPath.length).replace(/^[\\/]+/g, '');
                    const segments = relative.split(/[\\/]+/g).filter(Boolean);
                    let current = deepSearchRootDirectoryPath;
                    for (let i = 0; i < segments.length - 1; i += 1) {
                        current = joinMachinePath(current, segments[i] ?? '');
                        directoryPaths.add(current);
                    }
                }

                const directoryNodes: FilesystemBrowserNode[] = Array.from(directoryPaths)
                    .filter((path) => path !== deepSearchRootDirectoryPath)
                    .map((path) => ({
                        type: 'directory',
                        path,
                        name: getPathBrowserDisplayName(path),
                        depth: 0,
                        isExpanded: false,
                        isLoadingChildren: false,
                        parentDirectoryPath: deepSearchRootDirectoryPath,
                        source: 'remote' as const,
                    }));

                setDeepSearchNodes(directoryNodes);
                setDeepSearchLoading(false);
            })();
        }, DEEP_SEARCH_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [
        deepSearchEnabled,
        deepSearchReloadNonce,
        deepSearchRootDirectoryPath,
        props.machineId,
        props.serverId,
        searchQuery,
        selectionMode,
        showHidden,
    ]);

    const nodes = React.useMemo(() => {
        if (deepSearchEnabled) {
            return deepSearchNodes ?? [];
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
        return nodes.findIndex((node) => node.type === 'directory' && node.path === selectedPath);
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
    }, [interaction, props, selectedPath]);

    const selectedDirectoryPath = React.useMemo(() => {
        if (!selectedPath) return null;
        const node = nodes.find((candidate) => candidate.type === 'directory' && candidate.path === selectedPath) ?? null;
        return node ? node.path : null;
    }, [nodes, selectedPath]);

    const closeContextMenu = React.useCallback(() => {
        setContextMenuDirectoryPath(null);
        contextMenuAnchorRef.current = null;
    }, []);

    const openContextMenu = React.useCallback((directoryPath: string, anchorNode: View | null) => {
        if (!directoryPath) return;
        setSelectedPath(directoryPath);
        contextMenuAnchorRef.current = anchorNode;
        setContextMenuDirectoryPath(directoryPath);
    }, []);

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

    type ToolbarActionId = 'path-browser-filter' | 'path-browser-refresh' | 'path-browser-clear-search';

    type ToolbarActionConfig = Readonly<{
        id: ToolbarActionId;
        priority: number;
        order: number;
        icon: React.ReactNode;
        menuIcon: React.ComponentProps<typeof Ionicons>['name'];
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
                    <Octicons
                        name="filter"
                        size={16}
                        color={filterSelected ? theme.colors.textLink : theme.colors.textSecondary}
                    />
                ),
                menuIcon: 'funnel-outline',
                accessibilityLabel: t('files.toolbar.hiddenFiles'),
                selected: filterSelected,
                onPress: () => setShowHidden((prev) => !prev),
            },
            {
                id: 'path-browser-refresh',
                priority: 0,
                order: 1,
                icon: <Octicons name="sync" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'refresh-outline',
                accessibilityLabel: t('common.refresh'),
                onPress: refresh,
            },
        ];

        if (canClearSearch) {
            actions.push({
                id: 'path-browser-clear-search',
                priority: 2,
                order: 2,
                icon: <Octicons name="x" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'close-outline',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            });
        }

        return actions;
    }, [canClearSearch, filterSelected, refresh, theme.colors.textLink, theme.colors.textSecondary]);

    const visibleToolbarActionIds = React.useMemo(
        () => resolveVisibleFileBrowserToolbarActionIds({ toolbarWidth, actions: toolbarActions }),
        [toolbarActions, toolbarWidth],
    );

    const visibleToolbarActions = React.useMemo(() => (
        toolbarActions
            .filter((action) => visibleToolbarActionIds.has(action.id))
            .sort((left, right) => left.order - right.order)
    ), [toolbarActions, visibleToolbarActionIds]);

    const hiddenToolbarActions = React.useMemo(() => (
        toolbarActions.filter((action) => !visibleToolbarActionIds.has(action.id))
    ), [toolbarActions, visibleToolbarActionIds]);

    const moreActions = React.useMemo((): ItemAction[] => {
        const items: ItemAction[] = [
            {
                id: 'path-browser-collapse-all',
                title: t('files.repositoryCollapseAll'),
                icon: 'contract-outline',
                disabled: expandedPaths.length === 0,
                onPress: collapseAll,
            },
            {
                id: 'path-browser-create-folder',
                title: t('files.createFolderA11y'),
                icon: 'folder-outline',
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
                icon: 'close-outline',
                onPress: () => props.onRequestClose?.(),
            });
        }

        for (const hiddenAction of hiddenToolbarActions) {
            items.push({
                id: hiddenAction.id,
                title: hiddenAction.accessibilityLabel,
                icon: hiddenAction.menuIcon,
                disabled: hiddenAction.disabled,
                onPress: hiddenAction.onPress,
            });
        }

        return items;
    }, [collapseAll, createFolderInDirectory, expandedPaths.length, hiddenToolbarActions, isCreatingFolder, props, selectedDirectoryPath]);

        return (
            <View
                {...(variant === 'modal' ? { testID: PATH_BROWSER_MODAL_TEST_ID } : {})}
                style={[
                variant === 'modal' ? styles.container : null,
                modalLayoutStyle,
                variant !== 'modal' ? { flex: 1, minHeight: 0 } : null,
            ]}
        >
            {variant === 'modal' ? (
                <View style={styles.header}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={styles.title}>{props.title ?? t('newSession.pathPicker.enterPathTitle')}</Text>
                        <Text style={styles.subtitle}>{selectedPath ?? ''}</Text>
                    </View>
                    <View style={styles.headerActions}>
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
                                { opacity: (!selectedDirectoryPath || isCreatingFolder) ? 0.4 : (pressed ? 0.7 : 1) },
                            ])}
                            accessibilityRole="button"
                            accessibilityLabel={t('files.createFolderA11y')}
                        >
                            <Ionicons name="folder-outline" size={18} color={theme.colors.header.tint} />
                        </Pressable>
                        <Pressable
                            onPress={handleClose}
                            hitSlop={10}
                            style={({ pressed }) => ([styles.headerActionButton, { opacity: pressed ? 0.7 : 1 }])}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.close')}
                        >
                            <Octicons name="x" size={18} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>
                </View>
            ) : null}

            <View style={styles.body}>
                <FileBrowserToolbar
                    searchTestID="path-browser-search"
                    searchPlaceholder={t('files.searchPlaceholder')}
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    onWidthChange={setToolbarWidth}
                >
                    {visibleToolbarActions.map((action) => (
                        <FileBrowserToolbarIconButton
                            key={action.id}
                            testID={action.id}
                            accessibilityLabel={action.accessibilityLabel}
                            onPress={action.onPress}
                            selected={action.selected}
                            disabled={action.disabled}
                        >
                            {action.icon}
                        </FileBrowserToolbarIconButton>
                    ))}
                    <ItemRowActions
                        title={t('common.moreActions')}
                        actions={moreActions}
                        overflowTriggerTestID="path-browser-more"
                        compactThreshold={Number.POSITIVE_INFINITY}
                        compactActionIds={[]}
                        renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                            <FileBrowserToolbarIconButton
                                testID={testID ?? 'path-browser-more'}
                                accessibilityLabel={accessibilityLabel ?? t('common.moreActions')}
                                accessibilityHint={accessibilityHint}
                                accessibilityState={{ expanded: open }}
                                onPress={toggle}
                            >
                                <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                            </FileBrowserToolbarIconButton>
                        )}
                    />
                </FileBrowserToolbar>

                <FilesystemBrowser
                    nodes={nodes}
                    rootLoading={deepSearchEnabled ? deepSearchLoading : rootLoading}
                    rootError={deepSearchEnabled ? deepSearchError : rootError}
                    retryRoot={deepSearchEnabled ? (() => setDeepSearchReloadNonce((n) => n + 1)) : retryRoot}
                    loadingLabel={t('common.loading')}
                    loadingLabelCentered={t('common.loading')}
                    inlineRetryLabel={t('common.retry')}
                    emptyLabel={t('newSession.pathPicker.emptySuggested')}
                    style={{ flex: 1, minHeight: 0 }}
                    contentContainerStyle={{ paddingBottom: variant === 'modal' ? 16 : 0 }}
                    listRef={browserListRef}
                    onScrollToIndexFailed={handleScrollToIndexFailed}
                    renderRow={({ node, index, totalCount }) => {
                        const rowBasePaddingLeft = 24;
                        const rowDepthIndent = 12;
                        const rowPaddingLeft = rowBasePaddingLeft + Math.min(6, Math.max(0, node.depth)) * rowDepthIndent;
                        const selected = selectedPath === node.path && (
                            selectionMode === 'file' ? node.type === 'file' : node.type === 'directory'
                        );
                        const contextMenuRowAnchorRef = React.createRef<View>();
                        const handleTogglePress = (event?: GestureResponderEvent) => {
                            stopToggleEventPropagation(event);
                            void toggleDirectory(node.path);
                        };
                        const handleOpenContextMenu = (event?: unknown) => {
                            stopToggleEventPropagation(event);
                            const maybeEvent = event as { preventDefault?: () => void; stopPropagation?: () => void };
                            maybeEvent.preventDefault?.();
                            maybeEvent.stopPropagation?.();
                            openContextMenu(node.path, contextMenuRowAnchorRef.current);
                        };
                        const handleRowLongPress = () => {
                            openContextMenu(node.path, contextMenuRowAnchorRef.current);
                        };
                        const rightElement = selected
                            ? <Ionicons name="checkmark-circle" size={18} color={theme.colors.button.primary.background} />
                            : undefined;

                        const icon = node.type === 'directory'
                            ? (
                                <View style={styles.directoryIconWrap}>
                                    <Pressable
                                        testID={getPathBrowserToggleTestId(node.path)}
                                        {...(Platform.OS === 'web'
                                            ? ({ onMouseDownCapture: stopToggleEventPropagation } as any)
                                            : {})}
                                        onPressIn={stopToggleEventPropagation}
                                        onPress={handleTogglePress}
                                        hitSlop={10}
                                        style={styles.directoryToggle}
                                    >
                                        <Ionicons
                                            name={node.isExpanded ? 'chevron-down' : 'chevron-forward'}
                                            size={16}
                                            color={theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                    <Ionicons
                                        name={node.isExpanded ? 'folder-open-outline' : 'folder-outline'}
                                        size={18}
                                        color={theme.colors.textLink}
                                    />
                                </View>
                            )
                            : node.type === 'file'
                                ? <Ionicons name="document-outline" size={18} color={theme.colors.textLink} />
                                : <Ionicons name="folder-outline" size={18} color={theme.colors.textLink} />;

                        return (
                            <FilesystemBrowserRow
                                node={node}
                                index={index}
                                totalCount={totalCount}
                                title={
                                    node.type === 'info' && node.infoKind === 'truncated'
                                        ? t('newSession.pathPicker.truncatedDirectoryInfo', { count: node.entryCount ?? 0 })
                                        : node.name || node.path
                                }
                                subtitle={node.type === 'error' ? node.errorMessage : undefined}
                                icon={icon}
                                testID={getPathBrowserRowTestId(node.path)}
                                selected={selected}
                                rightElement={rightElement}
                                onContextMenu={node.type === 'directory' && enableContextMenu ? handleOpenContextMenu : undefined}
                                onLongPress={node.type === 'directory' && enableContextMenu ? handleRowLongPress : undefined}
                                basePaddingLeft={rowBasePaddingLeft}
                                depthIndent={rowDepthIndent}
                                density="tight"
                                errorTitle={t('errors.tryAgain')}
                                errorSubtitle={node.errorMessage}
	                                onRetryError={(errorNode) => {
	                                    if (errorNode.parentDirectoryPath) {
                                        void retryDirectory(errorNode.parentDirectoryPath);
                                    }
                                }}
                                onPress={() => {
                                    if (node.type === 'directory') {
                                        if (selectionMode === 'file') {
                                            void toggleDirectory(node.path);
                                            return;
                                        }
                                        if (interaction === 'immediate') {
                                            shouldAutoSelectInitialPathRef.current = false;
                                            shouldAutoScrollInitialSelectionRef.current = false;
                                            props.onPickPath(node.path);
                                            return;
                                        }
                                        shouldAutoSelectInitialPathRef.current = false;
                                        shouldAutoScrollInitialSelectionRef.current = false;
                                        setSelectedPath(node.path);
                                        return;
                                    }
                                    if (node.type === 'file') {
                                        if (selectionMode !== 'file') return;
                                        if (interaction === 'immediate') {
                                            shouldAutoSelectInitialPathRef.current = false;
                                            shouldAutoScrollInitialSelectionRef.current = false;
                                            props.onPickPath(node.path);
                                            return;
                                        }
                                        shouldAutoSelectInitialPathRef.current = false;
                                        shouldAutoScrollInitialSelectionRef.current = false;
                                        setSelectedPath(node.path);
                                    }
                                }}
                                wrapContent={({ content }) => (
                                    <View collapsable={false}>
                                        <View
                                            ref={contextMenuRowAnchorRef}
                                            collapsable={false}
                                            pointerEvents="none"
                                            style={{
                                                position: 'absolute',
                                                left: rowPaddingLeft,
                                                top: 0,
                                                bottom: 0,
                                                width: 1,
                                            }}
                                        />
                                        {content}
                                    </View>
                                )}
                            />
                        );
                    }}
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
                        icon: <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />,
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

            {variant === 'modal' && interaction === 'confirm' ? (
                <View style={styles.footer}>
                    <Text numberOfLines={1} style={styles.selectionText}>
                        {selectedPath ?? ''}
                    </Text>
                    <RoundButton title={t('common.cancel')} size="normal" display="inverted" onPress={handleClose} />
                    <RoundButton
                        testID={PATH_BROWSER_CONFIRM_TEST_ID}
                        title={t('common.use')}
                        size="normal"
                        onPress={handleConfirm}
                        disabled={!selectedPath}
                    />
                </View>
            ) : null}
        </View>
    );
}

export function MachinePathBrowserModal(props: MachinePathBrowserModalProps): React.ReactElement {
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
            onPickPath={(path) => {
                props.onResolve(path);
                props.onClose();
            }}
            onRequestClose={() => {
                props.onRequestClose?.();
                props.onResolve(null);
                props.onClose();
            }}
        />
    );
}
