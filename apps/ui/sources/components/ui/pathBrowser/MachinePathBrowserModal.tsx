import * as React from 'react';
import { FlatList, Platform, Pressable, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import {
    getCachedMachineFileBrowserDirectoryMetadata,
    getCachedMachineFileBrowserEntries,
    getCachedMachineFileBrowserRoots,
    listMachineFileBrowserDirectoryEntries,
    listMachineFileBrowserRoots,
    warmMachineFileBrowserDirectoryCache,
    warmMachineFileBrowserRoots,
} from '@/sync/domains/input/machineFileBrowser';
import { t } from '@/text';

import {
    getPathBrowserRowTestId,
    getPathBrowserToggleTestId,
    PATH_BROWSER_CONFIRM_TEST_ID,
    PATH_BROWSER_MODAL_TEST_ID,
} from './pathBrowserTestIds';

export type MachinePathBrowserModalProps = CustomModalInjectedProps & Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    onResolve: (path: string | null) => void;
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

function buildInitialSelectionCandidates(path: string | null): string[] {
    return buildInitialExpandedPaths(path).slice().reverse();
}

function toRootEntries(machineId: string, serverId?: string | null) {
    return (getCachedMachineFileBrowserRoots({ machineId, serverId }) ?? []).map((root) => ({
        name: root.label,
        path: root.path,
        type: 'directory' as const,
    }));
}

export function MachinePathBrowserModal(props: MachinePathBrowserModalProps): React.ReactElement {
    const { theme } = useUnistyles();
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const browserListRef = React.useRef<FlatList<FilesystemBrowserNode> | null>(null);
    const lastScrolledSelectionRef = React.useRef<string | null>(null);
    const shouldAutoScrollInitialSelectionRef = React.useRef(false);
    const initialPath = React.useMemo(() => normalizeAbsolutePath(props.initialPath ?? null), [props.initialPath]);
    const initialExpandedPaths = React.useMemo(() => buildInitialExpandedPaths(initialPath), [initialPath]);
    const initialSelectionCandidates = React.useMemo(() => buildInitialSelectionCandidates(initialPath), [initialPath]);
    const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = React.useState<string[]>(() => initialExpandedPaths);
    const shouldAutoSelectInitialPathRef = React.useRef(true);
    const modalLayoutStyle = React.useMemo(() => {
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
    }, [windowHeight, windowWidth]);

    const getCachedEntries = React.useCallback((directoryPath: string) => {
        if (directoryPath === '') {
            return toRootEntries(props.machineId, props.serverId);
        }
        return getCachedMachineFileBrowserEntries({
            machineId: props.machineId,
            serverId: props.serverId,
            directoryPath,
            includeFiles: false,
        })?.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            sizeBytes: entry.sizeBytes,
            modifiedMs: entry.modifiedMs,
        })) ?? null;
    }, [props.machineId, props.serverId]);

    const getCachedDirectoryMetadata = React.useCallback((directoryPath: string) => {
        if (directoryPath === '') {
            return { truncated: false };
        }
        return getCachedMachineFileBrowserDirectoryMetadata({
            machineId: props.machineId,
            serverId: props.serverId,
            directoryPath,
            includeFiles: false,
        });
    }, [props.machineId, props.serverId]);

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string): Promise<LazyDirectoryTreeLoadResult> => {
        if (directoryPath === '') {
            const result = await listMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
            if (!result.ok) return result;
            return {
                ok: true,
                entries: result.roots.map((root) => ({
                    name: root.label,
                    path: root.path,
                    type: 'directory' as const,
                })),
            };
        }
        const result = await listMachineFileBrowserDirectoryEntries({
            machineId: props.machineId,
            directoryPath,
            includeFiles: false,
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
            })),
            truncated: result.truncated,
        };
    }, [props.machineId, props.serverId]);

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string): Promise<LazyDirectoryTreeLoadResult> => {
        if (directoryPath === '') {
            const result = await warmMachineFileBrowserRoots({ machineId: props.machineId, serverId: props.serverId });
            if (!result.ok) return result;
            return {
                ok: true,
                entries: result.roots.map((root) => ({
                    name: root.label,
                    path: root.path,
                    type: 'directory' as const,
                })),
            };
        }
        const result = await warmMachineFileBrowserDirectoryCache({
            machineId: props.machineId,
            directoryPath,
            includeFiles: false,
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
            })),
            truncated: result.truncated,
        };
    }, [props.machineId, props.serverId]);

    const {
        nodes,
        rootLoading,
        rootError,
        retryRoot,
        retryDirectory,
        toggleDirectory,
    } = useLazyDirectoryTree({
        scopeKey: `${props.machineId}:${props.serverId ?? ''}`,
        enabled: true,
        rootDirectoryPath: '',
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        getCachedEntries,
        getCachedDirectoryMetadata,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit: 2,
    });

    React.useEffect(() => {
        shouldAutoSelectInitialPathRef.current = true;
        shouldAutoScrollInitialSelectionRef.current = initialSelectionCandidates.length > 0;
        setSelectedPath(null);
        setExpandedPaths(initialExpandedPaths);
        lastScrolledSelectionRef.current = null;
    }, [initialExpandedPaths, initialSelectionCandidates.length, props.machineId, props.serverId]);

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
        if (visibleCandidates.length === 0) {
            return;
        }

        const deepestVisibleCandidate = visibleCandidates[0] ?? null;
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
        props.onResolve(null);
        props.onClose();
    }, [props]);

    const handleConfirm = React.useCallback(() => {
        props.onResolve(selectedPath);
        props.onClose();
    }, [props, selectedPath]);

    return (
        <View testID={PATH_BROWSER_MODAL_TEST_ID} style={[styles.container, modalLayoutStyle]}>
            <View style={styles.header}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.title}>{props.title ?? t('newSession.pathPicker.enterPathTitle')}</Text>
                    <Text style={styles.subtitle}>{selectedPath ?? ''}</Text>
                </View>
                <Pressable
                    onPress={handleClose}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <FilesystemBrowser
                    nodes={nodes}
                    rootLoading={rootLoading}
                    rootError={rootError}
                    retryRoot={retryRoot}
                    loadingLabel={t('common.loading')}
                    loadingLabelCentered={t('common.loading')}
                    inlineRetryLabel={t('common.retry')}
                    emptyLabel={t('newSession.pathPicker.emptySuggested')}
                    style={{ flex: 1, minHeight: 0 }}
                    contentContainerStyle={{ paddingBottom: 16 }}
                    listRef={browserListRef}
                    onScrollToIndexFailed={handleScrollToIndexFailed}
                    renderRow={({ node, index, totalCount }) => {
                        const selected = node.type === 'directory' && selectedPath === node.path;
                        const handleTogglePress = (event?: GestureResponderEvent) => {
                            stopToggleEventPropagation(event);
                            void toggleDirectory(node.path);
                        };
                        const rightElement = node.type === 'error' || node.type === 'info'
                            ? undefined
                            : (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    {selected ? <Ionicons name="checkmark-circle" size={18} color={theme.colors.button.primary.background} /> : null}
                                    <Pressable
                                        testID={getPathBrowserToggleTestId(node.path)}
                                        onPressIn={stopToggleEventPropagation}
                                        onPress={handleTogglePress}
                                        hitSlop={8}
                                    >
                                        <Ionicons
                                            name={node.isExpanded ? 'chevron-down' : 'chevron-forward'}
                                            size={16}
                                            color={theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                </View>
                            );

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
                                icon={<Ionicons name={node.type === 'directory' && node.isExpanded ? 'folder-open-outline' : 'folder-outline'} size={18} color={theme.colors.textLink} />}
                                testID={getPathBrowserRowTestId(node.path)}
                                selected={selected}
                                rightElement={rightElement}
                                basePaddingLeft={16}
                                density="tight"
                                errorTitle={t('errors.tryAgain')}
                                errorSubtitle={node.errorMessage}
                                onRetryError={(errorNode) => {
                                    if (errorNode.parentDirectoryPath) {
                                        void retryDirectory(errorNode.parentDirectoryPath);
                                    }
                                }}
                                onPress={node.type !== 'directory' ? undefined : () => {
                                    shouldAutoSelectInitialPathRef.current = false;
                                    shouldAutoScrollInitialSelectionRef.current = false;
                                    setSelectedPath(node.path);
                                }}
                            />
                        );
                    }}
                />
            </View>

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
        </View>
    );
}
