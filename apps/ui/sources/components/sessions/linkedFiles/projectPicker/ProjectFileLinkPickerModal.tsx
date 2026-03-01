import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type ProjectFileLinkPickerModalProps = Readonly<{
    sessionId: string;
    onPickPath: (path: string) => void;
    onClose: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        maxWidth: 720,
        alignSelf: 'center',
        width: '100%',
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 12,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    title: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        flex: 1,
    },
    closeButton: {
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    body: { flex: 1 },
}));

export const ProjectFileLinkPickerModal = React.memo((props: ProjectFileLinkPickerModalProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title} numberOfLines={1}>
                    {t('files.projectLinkPicker.title')}
                </Text>
                <Pressable onPress={props.onClose} style={styles.closeButton} accessibilityRole="button">
                    <Octicons name="x" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <SessionRepositoryTreeBrowserView
                    sessionId={props.sessionId}
                    density="modal"
                    onOpenFile={(fullPath) => {
                        props.onPickPath(fullPath);
                        props.onClose();
                    }}
                    onOpenFilePinned={(fullPath) => {
                        props.onPickPath(fullPath);
                        props.onClose();
                    }}
                />
            </View>
        </View>
    );
});
