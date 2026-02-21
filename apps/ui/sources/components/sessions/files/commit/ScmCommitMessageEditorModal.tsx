import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';


export type ScmCommitMessageGenerateResult =
    | { ok: true; message: string }
    | { ok: false; error: string };

export function ScmCommitMessageEditorModal(props: Readonly<{
    title: string;
    initialMessage: string;
    canGenerate: boolean;
    onGenerate: () => Promise<ScmCommitMessageGenerateResult>;
    onResolve: (value: { kind: 'cancel' } | { kind: 'commit'; message: string }) => void;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const [message, setMessage] = React.useState(props.initialMessage);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [pendingSuggestion, setPendingSuggestion] = React.useState<string | null>(null);
    const latestMessageRef = React.useRef<string>(props.initialMessage);

    React.useEffect(() => {
        setMessage(props.initialMessage);
    }, [props.initialMessage]);

    React.useEffect(() => {
        latestMessageRef.current = message;
    }, [message]);

    const closeCancel = React.useCallback(() => {
        props.onResolve({ kind: 'cancel' });
        props.onClose();
    }, [props]);

    const commit = React.useCallback(() => {
        props.onResolve({ kind: 'commit', message });
        props.onClose();
    }, [message, props]);

    const applySuggestion = React.useCallback(() => {
        if (!pendingSuggestion) return;
        setMessage(pendingSuggestion);
        setPendingSuggestion(null);
        setError(null);
    }, [pendingSuggestion]);

    const generate = React.useCallback(async () => {
        if (!props.canGenerate || busy) return;
        setBusy(true);
        setError(null);
        setPendingSuggestion(null);
        const valueOnGenerate = latestMessageRef.current;

        try {
            const res = await props.onGenerate();
            if (!res.ok) {
                setError(res.error);
                return;
            }

            // Don't clobber user edits that happened while generation was running.
            const current = latestMessageRef.current;
            if (current === valueOnGenerate || current.trim().length === 0) {
                setMessage(res.message);
                return;
            }
            setPendingSuggestion(res.message);
            setError('A suggestion is ready. Apply it?');
        } finally {
            setBusy(false);
        }
    }, [busy, message, props]);

    const styles = StyleSheet.create({
        container: {
            backgroundColor: theme.colors.surface,
            borderRadius: 14,
            width: 520,
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
            paddingTop: 14,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.divider,
        },
        title: {
            fontSize: 16,
            color: theme.colors.text,
        },
        content: {
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12,
            gap: 10,
        },
        input: {
            minHeight: 140,
            borderWidth: 1,
            borderColor: theme.colors.divider,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            textAlignVertical: 'top' as any,
            color: theme.colors.text,
            backgroundColor: theme.colors.input.background,
        },
        error: {
            fontSize: 12,
            color: theme.colors.textDestructive,
        },
        footer: {
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
            paddingHorizontal: 12,
            paddingVertical: 10,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
        },
        button: {
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.divider,
            backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
            opacity: 1,
        },
        buttonDisabled: {
            opacity: 0.55,
        },
        primaryButton: {
            borderColor: theme.colors.textLink,
        },
        buttonText: {
            fontSize: 13,
            color: theme.colors.text,
        },
        buttonTextPrimary: {
            color: theme.colors.textLink,
        },
    });

    const Button = (p: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) => (
        <Pressable
            accessibilityRole="button"
            disabled={p.disabled}
            onPress={p.onPress}
            style={[
                styles.button,
                p.primary ? styles.primaryButton : null,
                p.disabled ? styles.buttonDisabled : null,
            ]}
        >
            <Text
                style={[
                    styles.buttonText,
                    Typography.default(p.primary ? 'semiBold' : undefined),
                    p.primary ? styles.buttonTextPrimary : null,
                ]}
            >
                {p.label}
            </Text>
        </Pressable>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={[styles.title, Typography.default('semiBold')]}>
                    {props.title}
                </Text>
            </View>

            <View style={styles.content}>
                <TextInput
                    style={[styles.input, Typography.default()]}
                    value={message}
                    placeholder="Commit message"
                    placeholderTextColor={theme.colors.input.placeholder}
                    onChangeText={(v) => setMessage(String(v))}
                    multiline={true}
                />

                {error ? (
                    <Text style={[styles.error, Typography.default()]}>
                        {error}
                    </Text>
                ) : null}
            </View>

            <View style={styles.footer}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button label="Cancel" onPress={closeCancel} disabled={busy} />
                    {props.canGenerate ? (
                        <Button label={busy ? 'Generating…' : 'Generate'} onPress={generate} disabled={busy} />
                    ) : null}
                    {pendingSuggestion ? (
                        <Button label="Apply suggestion" onPress={applySuggestion} disabled={busy} />
                    ) : null}
                </View>

                <Button label="Commit" primary={true} onPress={commit} disabled={busy} />
            </View>
        </View>
    );
}
