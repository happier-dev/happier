import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type PairingLinkEntryFormProps = Readonly<{
    /** The way back to the view that opened the form. Omitted, the host's own back is the only way out. */
    onBack?: () => void;
    onSubmit: (link: string) => Promise<boolean>;
    /**
     * Inside a host that already titles the step (the welcome pane, a setup card), the form is its
     * field and actions on the host's column: no heading of its own, the warning as the field's
     * help, and the way back as a quiet text action.
     */
    embedded?: boolean;
    /**
     * Surface copy. Defaults describe Home restore; the shared QR scanner passes the
     * account- and terminal-specific wording so link entry keeps each flow's voice
     * without a second entry surface.
     */
    title?: string;
    description?: string;
    placeholder?: string;
    submitLabel?: string;
    backLabel?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 560,
        alignSelf: 'center',
        paddingVertical: 28,
        gap: theme.space.s16,
    },
    title: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    description: {
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    field: {
        gap: theme.space.s8,
    },
    label: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    input: {
        minHeight: 54,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.mono(),
    },
    error: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.state.danger.foreground,
        ...Typography.default(),
    },
    actions: {
        gap: theme.space.s12,
    },
    embeddedContainer: {
        width: '100%',
        gap: theme.space.s16,
    },
    hint: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    embeddedActions: {
        width: '100%',
        alignItems: 'flex-start',
        gap: theme.space.s16,
    },
    embeddedPrimary: {
        width: '100%',
    },
}));

export const PairingLinkEntryForm = React.memo(function PairingLinkEntryForm(props: PairingLinkEntryFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const submittingRef = React.useRef(false);
    const [link, setLink] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const submit = React.useCallback(async () => {
        if (submittingRef.current) return;
        const trimmed = link.trim();
        if (!trimmed) {
            // An empty field is not a rejected link; saying "invalid" for it hides
            // what the user is actually being asked for.
            setError(t('connect.pairingLinkRequired'));
            inputRef.current?.focus();
            return;
        }
        submittingRef.current = true;
        setIsSubmitting(true);
        setError(null);
        try {
            const accepted = await props.onSubmit(trimmed);
            if (accepted) {
                setLink('');
                return;
            }
            setError(t('modals.invalidAuthUrl'));
            inputRef.current?.focus();
        } finally {
            submittingRef.current = false;
            setIsSubmitting(false);
        }
    }, [link, props.onSubmit]);

    const description = props.description ?? t('connect.pairingLinkSecurityWarning');
    const embedded = props.embedded === true;

    return (
        <View testID="pairing-link-entry-form" style={embedded ? styles.embeddedContainer : styles.container}>
            {embedded ? null : (
                <>
                    <Text style={styles.title}>{props.title ?? t('connect.enterUrlManually')}</Text>
                    <Text style={styles.description}>{description}</Text>
                </>
            )}
            <View style={styles.field}>
                <Text style={styles.label}>{t('connect.pairingLinkFieldLabel')}</Text>
                <TextInput
                    ref={inputRef}
                    testID="restore-pairing-link-input"
                    accessibilityLabel={t('connect.pairingLinkFieldLabel')}
                    accessibilityHint={description}
                    style={styles.input}
                    placeholder={props.placeholder ?? t('common.urlPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={link}
                    onChangeText={(next) => {
                        setLink(next);
                        if (error) setError(null);
                    }}
                    onSubmitEditing={() => {
                        void submit();
                    }}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    multiline={false}
                />
                {error ? (
                    <Text
                        testID="restore-pairing-link-error"
                        accessibilityRole="alert"
                        style={styles.error}
                    >
                        {error}
                    </Text>
                ) : embedded ? (
                    <Text testID="restore-pairing-link-hint" style={styles.hint}>{description}</Text>
                ) : null}
            </View>
            {embedded ? (
                <View style={styles.embeddedActions}>
                    <View style={styles.embeddedPrimary}>
                        <RoundButton
                            testID="restore-pairing-link-submit"
                            title={props.submitLabel ?? t('common.continue')}
                            action={submit}
                            loading={isSubmitting}
                        />
                    </View>
                    {props.onBack && props.backLabel ? (
                        <TextLinkButton
                            testID="restore-pairing-link-back"
                            label={props.backLabel}
                            onPress={props.onBack}
                        />
                    ) : null}
                </View>
            ) : (
                <View style={styles.actions}>
                    <RoundButton
                        testID="restore-pairing-link-submit"
                        title={props.submitLabel ?? t('common.continue')}
                        action={submit}
                        loading={isSubmitting}
                    />
                    {props.onBack ? (
                        <RoundButton
                            testID="restore-pairing-link-back"
                            title={props.backLabel ?? t('common.back')}
                            display="inverted"
                            onPress={props.onBack}
                        />
                    ) : null}
                </View>
            )}
        </View>
    );
});
