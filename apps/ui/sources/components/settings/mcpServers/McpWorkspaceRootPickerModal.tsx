import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import type { PathTargetPlatform } from '@/utils/path/browseSegments';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    resolveDirectoryFavoriteComparisonKey,
    toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';

export type McpWorkspaceRootPickerModalProps = CustomModalInjectedProps & Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    machineHomeDir: string;
    selectedPath: string;
    onSelectPath: (path: string) => void;
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
    machinePlatform?: PathTargetPlatform | string | null;
}>;

const stylesheet = StyleSheet.create(() => ({
    contentWrapper: {
        width: '100%',
        alignSelf: 'center',
    },
}));

export function McpWorkspaceRootPickerModal(props: McpWorkspaceRootPickerModalProps) {
    const styles = stylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();

    const [path, setPath] = React.useState(props.selectedPath);
    const favoriteDirectoryKeys = React.useMemo(() => new Set(
        props.favoriteDirectories.map((entry) =>
            resolveDirectoryFavoriteComparisonKey(entry, props.machineHomeDir)
        ),
    ), [props.favoriteDirectories, props.machineHomeDir]);
    const resolvedPlatform: PathTargetPlatform = React.useMemo(() => {
        if (props.machinePlatform === 'unix' || props.machinePlatform === 'windows' || props.machinePlatform === 'auto') {
            return props.machinePlatform;
        }
        if (typeof props.machinePlatform === 'string') {
            return machineMetadataPlatformToTarget(props.machinePlatform);
        }
        return 'auto';
    }, [props.machinePlatform]);

    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <View style={[styles.contentWrapper, maxWidthStyle]}>
                <PathSelectionList
                    machineHomeDir={props.machineHomeDir}
                    initialValue={path}
                    favorites={props.favoriteDirectories.map((entry) => ({ path: entry }))}
                    recents={[]}
                    machineId={props.machineId ?? null}
                    serverId={props.serverId ?? null}
                    machinePlatform={resolvedPlatform}
                    onCommit={(next) => {
                        setPath(next);
                        props.onSelectPath(next);
                        props.onClose();
                    }}
                    onRequestClose={() => {}}
                    isFavorite={(entry) => favoriteDirectoryKeys.has(
                        resolveDirectoryFavoriteComparisonKey(entry, props.machineHomeDir),
                    )}
                    onToggleFavorite={(entry) => {
                        props.onChangeFavoriteDirectories([...toggleHomeAwareDirectoryFavorite(
                            props.favoriteDirectories,
                            entry,
                            props.machineHomeDir,
                        )]);
                    }}
                    maxHeight={420}
                />
            </View>
        </ItemList>
    );
}
