import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StepFieldGroup, StepFieldHelp, StepFieldLabel } from '@/components/onboarding/unauthShell/StepFormParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text, type TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const LABEL_ID = 'restore-pairing-link-label';

export type PairingLinkEntryFormProps = Readonly<{
    /** The way back to the view that opened the form. Omitted, the host's own back is the only way out. */
    onBack?: () => void;
    onSubmit: (link: string) => Promise<boolean>;
    /**
     * Inside a host that already titles the step (the welcome pane, a setup card), the form is its
     * field and actions on the host's column: no heading of its own, the field and its action on one
     * row, the explanation under the field, and the way back as a quiet text action. It sits beside
     * other ways in, so the primary action is the host's: a pasted link proceeds on its own and a typed
     * one goes with Return or the row's secondary Continue.
     */
    embedded?: boolean;
    /**
     * Embedded: the row's action while the field is still empty (this device's camera), in place of
     * Continue. Typing a link brings Continue back.
     */
    emptyAction?: React.ReactNode;
    /** Focus the field on arrival (default). A host offering several ways turns it off when another is open. */
    autoFocus?: boolean;
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
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    actions: {
        gap: theme.space.s12,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // The field gives way to its action at any width (a phone keeps both on screen).
    fieldInput: {
        flex: 1,
        minWidth: 0,
    },
    quietAction: {
        alignItems: 'flex-start',
    },
}));

export const PairingLinkEntryForm = React.memo(function PairingLinkEntryForm(props: PairingLinkEntryFormProps) {
    const styles = stylesheet;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const submittingRef = React.useRef(false);
    const [link, setLink] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const submitLink = React.useCallback(async (value: string) => {
        if (submittingRef.current) return;
        const trimmed = value.trim();
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
    }, [props.onSubmit]);
    const submit = React.useCallback(() => submitLink(link), [link, submitLink]);

    const description = props.description ?? t('connect.pairingLinkSecurityWarning');
    const embedded = props.embedded === true;
    const submitButton = (
        <RoundButton
            testID="restore-pairing-link-submit"
            size={embedded ? 'normal' : undefined}
            display={embedded ? 'secondary' : undefined}
            title={props.submitLabel ?? t('common.continue')}
            action={submit}
            loading={isSubmitting}
        />
    );
    const field = (
        <FieldTextInput
            ref={inputRef}
            testID="restore-pairing-link-input"
            accessibilityLabel={t('connect.pairingLinkFieldLabel')}
            accessibilityLabelledBy={LABEL_ID}
            accessibilityHint={description}
            placeholder={props.placeholder ?? t('connect.pairingLinkPlaceholder')}
            value={link}
            onChangeText={(next) => {
                setLink(next);
                if (error) setError(null);
                // A whole link arriving into an empty field at once is a paste (or autofill), not typing.
                if (embedded && link.length === 0 && next.trim().length > 1) void submitLink(next);
            }}
            onSubmitEditing={() => {
                void submit();
            }}
            invalid={error !== null}
            autoFocus={props.autoFocus !== false}
            autoCapitalize="none"
            keyboardType="url"
            returnKeyType="go"
            monospace
            style={embedded ? styles.fieldInput : undefined}
        />
    );
    const help = error ? (
        <StepFieldHelp testID="restore-pairing-link-error" tone="error">{error}</StepFieldHelp>
    ) : embedded ? (
        <StepFieldHelp testID="restore-pairing-link-hint">{description}</StepFieldHelp>
    ) : null;

    if (embedded) {
        return (
            <StepFieldGroup testID="pairing-link-entry-form">
                <StepFieldLabel nativeID={LABEL_ID}>{t('connect.pairingLinkFieldLabel')}</StepFieldLabel>
                <View style={styles.fieldRow}>
                    {field}
                    {props.emptyAction && link.trim().length === 0 ? props.emptyAction : submitButton}
                </View>
                {help}
                {props.onBack && props.backLabel ? (
                    <View style={styles.quietAction}>
                        <TextLinkButton
                            testID="restore-pairing-link-back"
                            label={props.backLabel}
                            onPress={props.onBack}
                        />
                    </View>
                ) : null}
            </StepFieldGroup>
        );
    }

    return (
        <View testID="pairing-link-entry-form" style={styles.container}>
            <Text style={styles.title}>{props.title ?? t('connect.enterUrlManually')}</Text>
            <Text style={styles.description}>{description}</Text>
            <StepFieldGroup>
                <StepFieldLabel nativeID={LABEL_ID}>{t('connect.pairingLinkFieldLabel')}</StepFieldLabel>
                {field}
                {help}
            </StepFieldGroup>
            <View style={styles.actions}>
                {submitButton}
                {props.onBack ? (
                    <RoundButton
                        testID="restore-pairing-link-back"
                        title={props.backLabel ?? t('common.back')}
                        display="inverted"
                        onPress={props.onBack}
                    />
                ) : null}
            </View>
        </View>
    );
});
