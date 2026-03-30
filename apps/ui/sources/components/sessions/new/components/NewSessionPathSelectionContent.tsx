import * as React from 'react';
import { View, type ViewStyle } from 'react-native';

import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';

import { PathSelector } from './PathSelector';

export type NewSessionPathSelectionContentProps = Readonly<{
    machineHomeDir: string;
    selectedPath: string;
    onChangeSelectedPath: (path: string) => void;
    onSubmitSelectedPath?: (path: string) => void;
    submitBehavior?: React.ComponentProps<typeof PathSelector>['submitBehavior'];
    recentPaths: ReadonlyArray<string>;
    usePickerSearch: boolean;
    searchQuery: string;
    onChangeSearchQuery: (value: string) => void;
    favoriteDirectories: ReadonlyArray<string>;
    onChangeFavoriteDirectories: (dirs: string[]) => void;
    focusInputOnSelect?: boolean;
    machineBrowse?: React.ComponentProps<typeof PathSelector>['machineBrowse'];
}>;

export function NewSessionPathSelectionContent(props: NewSessionPathSelectionContentProps) {
    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <View style={styles.contentWrapper}>
                <PathSelector
                    machineHomeDir={props.machineHomeDir}
                    selectedPath={props.selectedPath}
                    onChangeSelectedPath={props.onChangeSelectedPath}
                    submitBehavior={props.submitBehavior}
                    onSubmitSelectedPath={props.onSubmitSelectedPath}
                    recentPaths={props.recentPaths}
                    usePickerSearch={props.usePickerSearch}
                    searchVariant="belowInput"
                    searchQuery={props.searchQuery}
                    onChangeSearchQuery={props.onChangeSearchQuery}
                    favoriteDirectories={props.favoriteDirectories}
                    onChangeFavoriteDirectories={props.onChangeFavoriteDirectories}
                    focusInputOnSelect={props.focusInputOnSelect}
                    machineBrowse={props.machineBrowse}
                />
            </View>
        </ItemList>
    );
}

const styles = {
    contentWrapper: {
        width: '100%' as const,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
    } satisfies ViewStyle,
};
