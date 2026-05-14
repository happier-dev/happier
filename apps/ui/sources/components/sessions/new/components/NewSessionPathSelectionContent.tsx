import * as React from 'react';
import { View, type ViewStyle } from 'react-native';

import { layout } from '@/components/ui/layout/layout';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    resolveDirectoryFavoriteComparisonKey,
    toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';

import { PathSelectionList } from './PathSelectionList';

export type NewSessionPathSelectionContentProps = Readonly<{
    machineHomeDir: string;
    selectedPath: string;
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
    const favoriteKeys = React.useMemo(() => new Set(
        props.favoriteDirectories.map((path) =>
            resolveDirectoryFavoriteComparisonKey(path, props.machineHomeDir)
        ),
    ), [props.favoriteDirectories, props.machineHomeDir]);
    return (
        <View style={styles.contentWrapper}>
            <PathSelectionList
                initialValue={props.selectedPath}
                machineHomeDir={props.machineHomeDir}
                favorites={props.favoriteDirectories.map((path) => ({ path }))}
                recents={props.recentPaths.map((path, index) => ({ path, lastUsedAt: index }))}
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
                onToggleFavorite={(path) => {
                    props.onChangeFavoriteDirectories([...toggleHomeAwareDirectoryFavorite(
                        props.favoriteDirectories,
                        path,
                        props.machineHomeDir,
                    )]);
                }}
                maxHeight={props.maxHeight}
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
