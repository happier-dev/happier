import * as React from 'react';
import { View, type ViewStyle } from 'react-native';

import { layout } from '@/components/ui/layout/layout';
import { resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    normalizeDirectoryFavoritePaths,
    resolveDirectoryFavoriteComparisonKey,
    toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';

import { PathSelectionList } from './PathSelectionList';
import type { PathSelectionInitialSuggestionMode } from './createPathSelectionInputBehavior';

export type NewSessionPathSelectionContentProps = Readonly<{
    machineHomeDir: string;
    selectedPath: string;
    /**
     * Popover callers use history-first so opening the path chip shows saved
     * locations before machine folder suggestions. Dedicated picker surfaces
     * omit this to preserve direct browse-from-selected-path behavior.
     */
    initialSuggestionMode?: PathSelectionInitialSuggestionMode;
    onChangeSelectedPath: (path: string) => void;
    onChangeDraftSelectedPath?: (path: string) => void;
    onSubmitSelectedPath?: (path: string) => void;
    onBeforeBrowseMachinePath?: () => void | Promise<void>;
    submitBehavior?: 'showRow' | 'confirm';
    commitDraftOnBlur?: boolean;
    recentPaths: ReadonlyArray<string>;
    usePickerSearch: boolean;
    searchQuery: string;
    onChangeSearchQuery: (value: string) => void;
    favoriteDirectories: ReadonlyArray<string>;
    onChangeFavoriteDirectories: (dirs: string[]) => void;
    focusInputOnSelect?: boolean;
    machineBrowse?: Readonly<{
        enabled: boolean;
        machineId: string | null;
        serverId?: string | null;
        title?: string;
    }>;
    machinePlatform?: string | null;
    maxHeight?: number;
}>;

export function NewSessionPathSelectionContent(props: NewSessionPathSelectionContentProps) {
    const machineId = props.machineBrowse?.enabled === true ? props.machineBrowse.machineId : null;
    const [optimisticFavoriteDirectories, setOptimisticFavoriteDirectories] = React.useState<ReadonlyArray<string>>(
        () => normalizeDirectoryFavoritePaths(props.favoriteDirectories, props.machineHomeDir),
    );
    React.useEffect(() => {
        setOptimisticFavoriteDirectories((current) => {
            const next = normalizeDirectoryFavoritePaths(props.favoriteDirectories, props.machineHomeDir);
            if (current.length === next.length && current.every((entry, index) => entry === next[index])) {
                return current;
            }
            return next;
        });
    }, [props.favoriteDirectories, props.machineHomeDir]);

    const visibleFavoriteDirectories = React.useMemo(
        () => normalizeDirectoryFavoritePaths(optimisticFavoriteDirectories, props.machineHomeDir),
        [optimisticFavoriteDirectories, props.machineHomeDir],
    );
    const favoriteKeys = React.useMemo(() => new Set(
        visibleFavoriteDirectories.map((path) =>
            resolveDirectoryFavoriteComparisonKey(path, props.machineHomeDir)
        ),
    ), [visibleFavoriteDirectories, props.machineHomeDir]);
    const recentEntries = React.useMemo(() => {
        const seenRecentKeys = new Set<string>();
        return props.recentPaths
            .filter((path) => typeof path === 'string' && path.trim().length > 0)
            .filter((path) => {
                const key = resolveDirectoryFavoriteComparisonKey(path, props.machineHomeDir);
                if (favoriteKeys.has(key)) return false;
                if (seenRecentKeys.has(key)) return false;
                seenRecentKeys.add(key);
                return true;
            })
            .map((path, index) => ({ path, lastUsedAt: index }));
    }, [favoriteKeys, props.machineHomeDir, props.recentPaths]);

    const handleToggleFavorite = React.useCallback((path: string) => {
        const next = toggleHomeAwareDirectoryFavorite(
            visibleFavoriteDirectories,
            path,
            props.machineHomeDir,
        );
        setOptimisticFavoriteDirectories(next);
        props.onChangeFavoriteDirectories([...next]);
    }, [props.machineHomeDir, props.onChangeFavoriteDirectories, visibleFavoriteDirectories]);

    return (
        <View style={styles.contentWrapper}>
            <PathSelectionList
                initialValue={props.selectedPath}
                initialSuggestionMode={props.initialSuggestionMode}
                machineHomeDir={props.machineHomeDir}
                favorites={visibleFavoriteDirectories.map((path) => ({ path }))}
                recents={recentEntries}
                machineId={machineId}
                serverId={props.machineBrowse?.serverId ?? null}
                machinePlatform={machineMetadataPlatformToTarget(props.machinePlatform)}
                onCommit={(path) => {
                    props.onChangeDraftSelectedPath?.(path);
                    props.onChangeSelectedPath(path);
                    props.onSubmitSelectedPath?.(path);
                }}
                onChangeDraftPath={props.onChangeDraftSelectedPath}
                onRequestClose={() => {}}
                onBeforeBrowseMachinePath={props.onBeforeBrowseMachinePath}
                isFavorite={(path) => favoriteKeys.has(resolveDirectoryFavoriteComparisonKey(path, props.machineHomeDir))}
                onToggleFavorite={handleToggleFavorite}
                maxHeight={props.maxHeight}
                heightBehavior={
                    props.maxHeight === undefined
                        ? undefined
                        : resolvePopoverSelectionListHeightBehavior('stabilizedContentHeight')
                }
            />
        </View>
    );
}

const styles = {
    contentWrapper: {
        width: '100%' as const,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
    } satisfies ViewStyle,
};
