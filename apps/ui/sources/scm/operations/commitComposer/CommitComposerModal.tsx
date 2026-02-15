import * as React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { CommitComposerDraft } from './commitComposerTypes';

export const CommitComposerModal = React.memo(function CommitComposerModal(props: Readonly<{
    initialTitle: string;
    initialBody: string;
    showGenerator: boolean;
    onGenerate?: () => Promise<CommitComposerDraft>;
    onSubmit: (draft: CommitComposerDraft) => void;
    onCancel: () => void;
    onRequestClose?: () => void;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const [title, setTitle] = React.useState(props.initialTitle);
    const [body, setBody] = React.useState(props.initialBody);
    const [busy, setBusy] = React.useState(false);

    const message = React.useMemo(() => {
        const normalizedTitle = title.trim();
        const normalizedBody = body.trim();
        if (!normalizedBody) return normalizedTitle;
        return `${normalizedTitle}\n\n${normalizedBody}`;
    }, [body, title]);

    const closeAsCancel = React.useCallback(() => {
        try {
            props.onRequestClose?.();
        } finally {
            props.onCancel();
            props.onClose();
        }
    }, [props]);

    const handleSubmit = React.useCallback(() => {
        props.onSubmit({ title: title.trim(), body: body.trim(), message });
        props.onClose();
    }, [body, message, props, title]);

    const handleGenerate = React.useCallback(async () => {
        if (!props.onGenerate) return;
        try {
            setBusy(true);
            const draft = await props.onGenerate();
            setTitle(draft.title);
            setBody(draft.body);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to generate commit message');
        } finally {
            setBusy(false);
        }
    }, [props.onGenerate]);

    const styles = StyleSheet.create({
        container: {
            width: 520,
            maxWidth: '92%',
            backgroundColor: theme.colors.surface,
            borderRadius: 14,
            padding: 16,
            gap: 12,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
        },
        titleText: {
            fontSize: 18,
            color: theme.colors.text,
        },
        inputLabel: {
            fontSize: 12,
            color: theme.colors.textSecondary,
        },
        input: {
            borderWidth: 1,
            borderColor: theme.colors.divider,
            backgroundColor: theme.colors.input.background,
            color: theme.colors.text,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 14,
        },
        bodyInput: {
            minHeight: 110,
            textAlignVertical: 'top',
        },
        actions: {
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 6,
        },
        button: {
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderWidth: 1,
            borderColor: theme.colors.divider,
        },
        primaryButton: {
            backgroundColor: theme.colors.textLink,
            borderColor: theme.colors.textLink,
        },
        buttonText: {
            fontSize: 14,
            color: theme.colors.text,
        },
        primaryText: {
            color: theme.colors.surface,
        },
        buttonDisabled: {
            opacity: 0.6,
        },
    });

    const canSubmit = title.trim().length > 0 && !busy;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={[styles.titleText, Typography.default('semiBold')]}>Create commit</Text>
                {busy ? <ActivityIndicator size="small" /> : null}
            </View>

            <View style={{ gap: 6 }}>
                <Text style={[styles.inputLabel, Typography.default()]}>Title</Text>
                <TextInput
                    value={title}
                    onChangeText={setTitle}
                    placeholder="feat: short summary"
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[styles.input, Typography.default()]}
                    editable={!busy}
                />
            </View>

            <View style={{ gap: 6 }}>
                <Text style={[styles.inputLabel, Typography.default()]}>Body (optional)</Text>
                <TextInput
                    value={body}
                    onChangeText={setBody}
                    placeholder="Longer description, bullets, etc."
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[styles.input, styles.bodyInput, Typography.default()]}
                    editable={!busy}
                    multiline={true}
                />
            </View>

            <View style={styles.actions}>
                {props.showGenerator ? (
                    <Pressable
                        accessibilityRole="button"
                        onPress={handleGenerate}
                        disabled={busy || !props.onGenerate}
                        style={({ pressed }) => [
                            styles.button,
                            (busy || !props.onGenerate) && styles.buttonDisabled,
                            pressed && !busy ? { opacity: 0.8 } : null,
                        ]}
                    >
                        <Text style={[styles.buttonText, Typography.default()]}>Generate message</Text>
                    </Pressable>
                ) : null}

                <Pressable
                    accessibilityRole="button"
                    onPress={closeAsCancel}
                    disabled={busy}
                    style={({ pressed }) => [
                        styles.button,
                        busy && styles.buttonDisabled,
                        pressed && !busy ? { opacity: 0.8 } : null,
                    ]}
                >
                    <Text style={[styles.buttonText, Typography.default()]}>Cancel</Text>
                </Pressable>

                <Pressable
                    accessibilityRole="button"
                    onPress={handleSubmit}
                    disabled={!canSubmit}
                    style={({ pressed }) => [
                        styles.button,
                        styles.primaryButton,
                        !canSubmit && styles.buttonDisabled,
                        pressed && canSubmit ? { opacity: 0.9 } : null,
                    ]}
                >
                    <Text style={[styles.buttonText, styles.primaryText, Typography.default('semiBold')]}>Commit</Text>
                </Pressable>
            </View>
        </View>
    );
});

