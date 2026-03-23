import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PathSelector } from '@/components/sessions/new/components/PathSelector';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';

export type McpWorkspaceRootPickerModalProps = CustomModalInjectedProps & Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    machineHomeDir: string;
    selectedPath: string;
    onSelectPath: (path: string) => void;
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 720,
        maxHeight: 720,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerText: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
}));

export function McpWorkspaceRootPickerModal(props: McpWorkspaceRootPickerModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [path, setPath] = React.useState(props.selectedPath);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerText}>{t('settings.mcpServersPickWorkspaceTitle')}</Text>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

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
        </View>
    );
}
