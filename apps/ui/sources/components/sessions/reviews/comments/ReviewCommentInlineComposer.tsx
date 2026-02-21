import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';


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
                placeholder="Add a review comment…"
                placeholderTextColor={theme.colors.textSecondary}
                multiline
                style={styles.input}
            />
            <View style={styles.actions}>
                {props.onDelete ? (
                    <Pressable onPress={props.onDelete} style={styles.dangerButton}>
                        <Text style={styles.dangerText}>Delete</Text>
                    </Pressable>
                ) : null}
                <View style={{ flex: 1 }} />
                <Pressable onPress={props.onCancel} style={styles.secondaryButton}>
                    <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={props.onSave} style={styles.primaryButton}>
                    <Text style={styles.primaryText}>Save</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: 46,
        marginRight: 8,
        marginTop: 6,
        marginBottom: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider ?? '#ddd',
        backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surface ?? '#fff',
        gap: 10,
    },
    input: {
        minHeight: 54,
        maxHeight: 160,
        padding: 0,
        color: theme.colors.text,
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
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
        backgroundColor: theme.colors.button?.primary?.background ?? theme.colors.text ?? '#000',
    },
    primaryText: {
        color: theme.colors.button?.primary?.tint ?? theme.colors.surface ?? '#fff',
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    secondaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfacePressed ?? theme.colors.surface ?? '#fff',
        borderWidth: 1,
        borderColor: theme.colors.divider ?? '#ddd',
    },
    secondaryText: {
        color: theme.colors.button?.secondary?.tint ?? theme.colors.textSecondary ?? '#666',
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
    dangerButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfacePressed,
    },
    dangerText: {
        color: theme.colors.textDestructive,
        fontSize: 12,
        fontWeight: '700',
        ...Typography.default('semiBold'),
    },
}));
