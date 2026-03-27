import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { DirectSessionsBrowseScreen, type DirectSessionsBrowseScopeLock } from './DirectSessionsBrowseScreen';

export type DirectSessionsResumeIdPickerModalProps = CustomModalInjectedProps & Readonly<{
    lockScope: DirectSessionsBrowseScopeLock;
    title?: string;
    onResolve: (value: string | null) => void;
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 560,
        maxWidth: '94%',
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
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    headerActionButton: {
        padding: 2,
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
}));

export const DirectSessionsResumeIdPickerModal = React.memo(function DirectSessionsResumeIdPickerModal(
    props: DirectSessionsResumeIdPickerModalProps,
) {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();
    const styles = stylesheet;

    const handleRequestClose = React.useCallback(() => {
        props.onRequestClose?.();
        props.onClose();
    }, [props]);

    const title = props.title ?? t('directSessions.browseTitle');
    const modalHeight = Math.min(Math.max(320, windowDimensions.height * 0.92), 860);
    const modalWidth = Math.min(560, Math.max(320, windowDimensions.width * 0.94));

    return (
        <View style={[styles.container, { height: modalHeight, width: modalWidth }]} testID="resume-id-browse-modal">
            <View style={styles.header}>
                <Text style={styles.title}>{title}</Text>
                <View style={styles.headerActions}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                        onPress={handleRequestClose}
                        style={({ pressed }) => [
                            styles.headerActionButton,
                            { opacity: pressed ? 0.7 : 1 },
                        ]}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>

            <View style={styles.body}>
                <DirectSessionsBrowseScreen
                    interaction="pickRemoteSessionId"
                    lockScope={props.lockScope}
                    onPickRemoteSessionId={(remoteSessionId) => {
                        props.onResolve(remoteSessionId);
                        props.onClose();
                    }}
                />
            </View>
        </View>
    );
});
