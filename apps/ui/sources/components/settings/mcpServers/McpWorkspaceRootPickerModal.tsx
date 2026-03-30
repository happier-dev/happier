import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PathSelector } from '@/components/sessions/new/components/PathSelector';
import { layout } from '@/components/ui/layout/layout';

export type McpWorkspaceRootPickerModalProps = CustomModalInjectedProps & Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    machineHomeDir: string;
    selectedPath: string;
    onSelectPath: (path: string) => void;
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
}>;

const stylesheet = StyleSheet.create({
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
});

export function McpWorkspaceRootPickerModal(props: McpWorkspaceRootPickerModalProps) {
    const styles = stylesheet;

    const [path, setPath] = React.useState(props.selectedPath);

    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <View style={styles.contentWrapper}>
                <PathSelector
                    machineHomeDir={props.machineHomeDir}
                    selectedPath={path}
                    onChangeSelectedPath={setPath}
                    onSubmitSelectedPath={(next) => {
                        props.onSelectPath(next);
                        props.onClose();
                    }}
                    submitBehavior="confirm"
                    recentPaths={[]}
                    usePickerSearch={false}
                    searchVariant="none"
                    favoriteDirectories={props.favoriteDirectories}
                    onChangeFavoriteDirectories={props.onChangeFavoriteDirectories}
                    focusInputOnSelect={false}
                    machineBrowse={{
                        enabled: true,
                        machineId: props.machineId ?? null,
                        serverId: props.serverId ?? null,
                    }}
                />
            </View>
        </ItemList>
    );
}
