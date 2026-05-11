import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { TextInput } from '@/components/ui/text/Text';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { t } from '@/text';

export type ContextBarMode = 'machine_only' | 'workspace_only' | 'machine_and_workspace';

type ContextBarProps = Readonly<{
    mode: ContextBarMode;
    machine?: Readonly<{
        title?: string;
        selectedId: string | null;
        subtitle: string;
        items: DropdownMenuItem[];
        onSelect: (machineId: string) => void;
    }>;
    workspace?: Readonly<{
        value: string;
        placeholder: string;
        onChange: (value: string) => void;
        testID?: string;
        browse?: Readonly<{
            machineId: string | null;
            serverId?: string | null;
            title?: string;
            enabled?: boolean;
        }>;
    }>;
}>;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 10,
    },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        width: '100%',
    },
    inputWrapper: {
        flex: 1,
    },
    workspaceInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));

export const ContextBar = React.memo(function ContextBar(props: ContextBarProps) {
    const { theme } = useUnistyles();
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);

    const showMachine = props.mode === 'machine_only' || props.mode === 'machine_and_workspace';
    const showWorkspace = props.mode === 'workspace_only' || props.mode === 'machine_and_workspace';

    const handleBrowseWorkspace = React.useCallback(async () => {
        if (!props.workspace?.browse?.machineId) return;
        const selected = await openMachinePathBrowserModal({
            machineId: props.workspace.browse.machineId,
            serverId: props.workspace.browse.serverId,
            title: props.workspace.browse.title,
            initialPath: props.workspace.value,
        });
        if (selected) {
            props.workspace.onChange(selected);
        }
    }, [props.workspace]);

    return (
        <View style={styles.container}>
            {showMachine && props.machine ? (
                <DropdownMenu
                    open={machineMenuOpen}
                    onOpenChange={setMachineMenuOpen}
                    items={props.machine.items}
                    selectedId={props.machine.selectedId}
                    onSelect={props.machine.onSelect}
                    itemTrigger={{
                        title: props.machine.title ?? t('promptLibrary.externalAssetsMachine'),
                        subtitle: props.machine.subtitle,
                        icon: <Ionicons name="laptop-outline" size={29} color={theme.colors.accent.blue} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
            ) : null}

            {showWorkspace && props.workspace ? (
                <Item
                    title={t('promptLibrary.externalAssetsProjectDirectory')}
                    subtitle={(
                        <View style={styles.workspaceInputRow}>
                            <TextInput
                                testID={props.workspace.testID}
                                style={[styles.input, styles.inputWrapper]}
                                value={props.workspace.value}
                                onChangeText={props.workspace.onChange}
                                placeholder={props.workspace.placeholder}
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                            {props.workspace.browse?.enabled !== false ? (
                                <PathInputBrowseButton
                                    onPress={handleBrowseWorkspace}
                                    disabled={!props.workspace.browse?.machineId}
                                />
                            ) : null}
                        </View>
                    )}
                    subtitleLines={0}
                    icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.indigo} />}
                    mode="info"
                    showChevron={false}
                />
            ) : null}
        </View>
    );
});
