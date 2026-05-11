import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';


export function ReviewCommentInlineComposer(props: {
    value: string;
    onChange: (next: string) => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete?: () => void;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <TextInput
                value={props.value}
                onChangeText={props.onChange}
                placeholder={t('files.reviewComments.placeholder')}
                placeholderTextColor={theme.colors.text.secondary}
                multiline
                style={styles.input}
            />
            <View style={styles.actions}>
                {props.onDelete ? (
                    <Pressable onPress={props.onDelete} style={styles.dangerButton}>
                        <Text style={styles.dangerText}>{t('common.delete')}</Text>
                    </Pressable>
                ) : null}
                <View style={{ flex: 1 }} />
                <Pressable onPress={props.onCancel} style={styles.secondaryButton}>
                    <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={props.onSave} style={styles.primaryButton}>
                    <Text style={styles.primaryText}>{t('common.save')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: 0,
        marginRight: 8,
        marginTop: 0,
        marginBottom: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
        gap: 10,
    },
    input: {
        minHeight: 54,
        maxHeight: 160,
        padding: 0,
        color: theme.colors.text.primary,
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        ...(Platform.select({
            web: {
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    primaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.button?.primary?.background ?? theme.colors.text.primary,
    },
    primaryText: {
        color: theme.colors.button?.primary?.tint ?? theme.colors.surface.base,
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    secondaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.pressed ?? theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    secondaryText: {
        color: theme.colors.button?.secondary?.tint ?? theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    dangerButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.pressed,
    },
    dangerText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
}));
