import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { RepositoryTreeList } from '@/components/sessions/files/content/RepositoryTreeList';
import { SearchResultsList } from '@/components/sessions/files/content/SearchResultsList';
import { ChangedFilesTreeList } from '@/components/sessions/files/content/ChangedFilesTreeList';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { fileSearchCache, searchFiles } from '@/sync/domains/input/suggestionFile';
import { storage, useMachine, useSession, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sessionCreateDirectory, sessionWriteFile } from '@/sync/ops';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { computeExpandedPathsForReveal } from '@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { SourceControlSessionInactiveState } from '@/components/sessions/sourceControl/states';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

export type SessionRepositoryTreeBrowserViewProps = Readonly<{
    sessionId: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
    /**
     * Allows browsing/linking files even when the session is inactive.
     * Useful for read-only surfaces like the agent input "Link file" popover.
     */
    allowWhenSessionInactive?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    toolbar: {
        position: 'relative',
        zIndex: 10,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    searchInput: {
        flex: 1,
        height: 34,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHigh,
        ...Typography.default(),
        fontSize: 13,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
}));

export const SessionRepositoryTreeBrowserView = React.memo((props: SessionRepositoryTreeBrowserViewProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const machineId = typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : '';
    const machine = useMachine(machineId);
    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: Boolean(machine),
        machineIsOnline: machine ? isMachineOnline(machine) : false,
    });
    const isSessionInactive = session?.active === false;
    const allowWhenSessionInactive = props.allowWhenSessionInactive === true;

    const expandedPaths = useSessionRepositoryTreeExpandedPaths(props.sessionId);
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    const didWarmScmRef = React.useRef<string | null>(null);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const showSearchBar = props.showSearchBar !== false;
    const allowCreateActions = !isSessionInactive;

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    React.useEffect(() => {
        if (isSessionInactive) return;
        const key = `${props.sessionId}:${treeReloadNonce}`;
        if (didWarmScmRef.current === key) return;
        didWarmScmRef.current = key;
        // Warm SCM snapshot so the file tree can display change badges even if the user
        // hasn't opened the Source control panel yet.
        scmStatusSync.invalidateFromUser(props.sessionId);
    }, [props.sessionId, treeReloadNonce]);

    React.useEffect(() => {
        let cancelled = false;
        const q = searchQuery.trim();
        if (showChangedOnly) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }
        if (!q) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const handle = setTimeout(() => {
            void (async () => {
                try {
                    const results = await searchFiles(props.sessionId, q, { limit: 200 });
                    if (cancelled) return;
                    setSearchResults(results);
                } finally {
                    if (cancelled) return;
                    setIsSearching(false);
                }
            })();
        }, 120);

        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [props.sessionId, searchQuery, showChangedOnly]);

    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;
    const canClearSearch = searchQuery.length > 0;
    const refresh = React.useCallback(() => {
        fileSearchCache.clearCache(props.sessionId);
        scmStatusSync.invalidateFromUser(props.sessionId);
        setTreeReloadNonce((n) => n + 1);
    }, [props.sessionId]);

    const collapseAll = React.useCallback(() => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, []);
    }, [props.sessionId]);

    const createFile = React.useCallback(() => {
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

            const res = await sessionWriteFile(props.sessionId, path, '', null);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFileFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: path,
            });
            storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, nextExpanded);
            refresh();

            (props.onOpenFilePinned ?? props.onOpenFile)(path);
        })();
    }, [expandedPaths, props.onOpenFile, props.onOpenFilePinned, props.sessionId, refresh]);

    const createFolder = React.useCallback(() => {
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

            const res = await sessionCreateDirectory(props.sessionId, directoryPath);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                // Expand the newly-created directory itself by using a synthetic child path.
                fullPath: `${directoryPath}/.placeholder`,
            });
            const withDir = nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath];
            storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, withDir);
            refresh();
        })();
    }, [expandedPaths, props.sessionId, refresh]);

    if (isSessionInactive) {
        if (!allowWhenSessionInactive) {
            return <SourceControlSessionInactiveState machineReachable={machineReachable} />;
        }
    }

    return (
        <View style={{ flex: 1 }}>
            {showSearchBar ? (
                <View style={styles.toolbar}>
                    <TextInput
                        testID="repository-tree-search"
                        placeholder={t('files.searchPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        style={styles.searchInput}
                    />
                    <Pressable
                        testID="repository-tree-filter-changed"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.toolbar.changedFiles')}
                        onPress={() => setShowChangedOnly((prev) => !prev)}
                        style={[
                            styles.iconButton,
                            showChangedOnly ? { backgroundColor: theme.colors.surface, borderColor: theme.colors.textLink } : null,
                        ]}
                        hitSlop={10}
                    >
                        <Octicons name="filter" size={16} color={showChangedOnly ? theme.colors.textLink : theme.colors.textSecondary} />
                    </Pressable>
	                    <Pressable
	                        testID="repository-tree-create-file"
	                        accessibilityRole="button"
	                        accessibilityLabel={t('files.createFileA11y')}
	                        onPress={createFile}
	                        style={[styles.iconButton, !allowCreateActions ? { opacity: 0.35 } : null]}
	                        hitSlop={10}
	                        disabled={!allowCreateActions}
	                    >
	                        <Ionicons name="document-text-outline" size={16} color={theme.colors.textSecondary} />
	                    </Pressable>
	                    <Pressable
	                        testID="repository-tree-create-folder"
	                        accessibilityRole="button"
	                        accessibilityLabel={t('files.createFolderA11y')}
	                        onPress={createFolder}
	                        style={[styles.iconButton, !allowCreateActions ? { opacity: 0.35 } : null]}
	                        hitSlop={10}
	                        disabled={!allowCreateActions}
	                    >
	                        <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />
	                    </Pressable>
                    {canClearSearch ? (
                        <Pressable
                            testID="repository-tree-clear-search"
                            accessibilityRole="button"
                            accessibilityLabel={t('files.clearSearchA11y')}
                            onPress={() => setSearchQuery('')}
                            style={styles.iconButton}
                            hitSlop={10}
                        >
                            <Octicons name="x" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                    <Pressable
                        testID="repository-tree-refresh"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.refresh')}
                        onPress={refresh}
                        style={styles.iconButton}
                        hitSlop={10}
                    >
                        <Octicons name="sync" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                    <Pressable
                        testID="repository-tree-collapse-all"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.repositoryCollapseAll')}
                        disabled={expandedPaths.length === 0}
                        onPress={collapseAll}
                        style={[
                            styles.iconButton,
                            expandedPaths.length === 0 ? { opacity: 0.25 } : null,
                        ]}
                        hitSlop={10}
                    >
                        <Ionicons name="contract-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                    {props.onRequestClose ? (
                        <Pressable
                            testID="repository-tree-close"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.close')}
                            onPress={props.onRequestClose}
                            style={styles.iconButton}
                            hitSlop={10}
                        >
                            <Octicons name="x" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            <View style={{ flex: 1, position: 'relative' }}>
                {shouldShowSearchResults ? (
                    <SearchResultsList
                        theme={theme}
                        isSearching={isSearching}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        onFilePress={(file) => props.onOpenFile(file.fullPath)}
                        onFilePressPinned={(file) => (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath)}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    />
                ) : showChangedOnly && scmSnapshot?.repo.isRepo ? (
                    <ChangedFilesTreeList
                        theme={theme}
                        snapshot={scmSnapshot}
                        searchQuery={searchQuery}
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    />
                ) : (
                    <RepositoryTreeList
                        theme={theme}
                        sessionId={props.sessionId}
                        reloadToken={treeReloadNonce}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={(paths) => storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, paths)}
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                        scmSnapshot={scmSnapshot}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    />
                )}
                <ScrollEdgeFades
                    color={theme.colors.surface}
                    size={18}
                    edges={scrollFades.visibility}
                />
                <ScrollEdgeIndicators
                    edges={scrollFades.visibility}
                    color={theme.colors.textSecondary}
                    size={14}
                    opacity={0.35}
                />
            </View>
        </View>
    );
});
