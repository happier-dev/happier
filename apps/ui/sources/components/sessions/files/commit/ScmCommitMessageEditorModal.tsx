import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 10,
    },
    input: {
        minHeight: 140,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top' as any,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
    },
    error: {
        fontSize: 12,
        color: theme.colors.state.danger.foreground,
    },
    footer: {
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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
        opacity: 1,
    },
    buttonDisabled: {
        opacity: 0.55,
    },
    primaryButton: {
        borderColor: theme.colors.text.link,
    },
    buttonText: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    buttonTextPrimary: {
        color: theme.colors.text.link,
    },
}));


export type ScmCommitMessageGenerateResult =
    | { ok: true; message: string }
    | { ok: false; error: string };

export type ScmCommitMessageEditorModalProps = CustomModalInjectedProps & Readonly<{
    initialMessage: string;
    canGenerate: boolean;
    onGenerate: () => Promise<ScmCommitMessageGenerateResult>;
    onResolve: (value: { kind: 'cancel' } | { kind: 'commit'; message: string }) => void;
    onRequestClose?: () => void;
}>;

export function ScmCommitMessageEditorModal(props: ScmCommitMessageEditorModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { onClose, onResolve } = props;
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
        onResolve({ kind: 'cancel' });
        onClose();
    }, [onClose, onResolve]);

    const commit = React.useCallback(() => {
        onResolve({ kind: 'commit', message });
        onClose();
    }, [message, onClose, onResolve]);

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
            setError(t('files.commitMessageEditor.suggestionReady'));
        } finally {
            setBusy(false);
        }
    }, [busy, props.canGenerate, props.onGenerate]);

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

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label={t('common.cancel')} onPress={closeCancel} disabled={busy} />
                {props.canGenerate ? (
                    <Button
                        label={busy ? t('files.commitMessageEditor.generating') : t('files.commitMessageEditor.generate')}
                        onPress={generate}
                        disabled={busy}
                    />
                ) : null}
                {pendingSuggestion ? (
                    <Button label={t('files.commitMessageEditor.applySuggestion')} onPress={applySuggestion} disabled={busy} />
                ) : null}
            </View>

            <Button label={t('files.commitMessageEditor.commit')} primary={true} onPress={commit} disabled={busy} />
        </View>
    ), [applySuggestion, busy, closeCancel, commit, generate, pendingSuggestion, props.canGenerate, styles.footer]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        footer,
    }), [footer]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <View style={styles.content}>
                <TextInput
                    style={[styles.input, Typography.default()]}
                    value={message}
                    placeholder={t('files.commitMessageEditor.placeholder')}
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
        </View>
    );
}
