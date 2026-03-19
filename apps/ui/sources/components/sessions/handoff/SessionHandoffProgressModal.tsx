import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type Props = CustomModalInjectedProps & Readonly<{
    title?: string;
    message?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 420,
        maxWidth: '92%',
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
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        flex: 1,
    },
}));

export function SessionHandoffProgressModal({ onClose, title, message }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{title ?? t('sessionHandoff.progress.title')}</Text>
                <Pressable
                    onPress={onClose}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                <Text style={styles.message}>{message ?? t('sessionHandoff.progress.message')}</Text>
            </View>
        </View>
    );
}

export default SessionHandoffProgressModal;
