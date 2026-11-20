import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StepFieldGroup, StepFieldHelp, StepFieldLabel, StepForm } from '@/components/onboarding/unauthShell/StepFormParts';
import { StepPrimaryButton } from '@/components/onboarding/unauthShell/stepBack';
import { StepActions } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
     * Inside a step that already titles itself (lab direction A "Paste a pairing link"): the field, a line under it
     * only when the host passes one or a link is refused, then the step's actions (Back beside one primary). A pasted
     * link proceeds on its own; a typed one goes with Return or the primary.
     */
    embedded?: boolean;
    /** Focus the field on arrival (default). A host offering several ways turns it off when another is open. */
    autoFocus?: boolean;
    /**
     * Surface copy. Defaults describe Home restore; the shared QR scanner passes the
     * account- and terminal-specific wording so link entry keeps each flow's voice
     * without a second entry surface.
     */
    title?: string;
    fieldLabel?: string;
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
    // The field, then the step's actions a section below (the step frame's rhythm).
    step: {
        width: '100%',
        gap: theme.space.s24,
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
    const fieldLabel = props.fieldLabel ?? t('connect.pairingLinkFieldLabel');
    const embedded = props.embedded === true;
    const submitButton = (
        <RoundButton
            testID="restore-pairing-link-submit"
            title={props.submitLabel ?? t('common.continue')}
            action={submit}
            loading={isSubmitting}
        />
    );
    const field = (
        <FieldTextInput
            ref={inputRef}
            testID="restore-pairing-link-input"
            accessibilityLabel={fieldLabel}
            accessibilityLabelledBy={embedded ? undefined : LABEL_ID}
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
        />
    );
    const help = error ? (
        <StepFieldHelp testID="restore-pairing-link-error" tone="error">{error}</StepFieldHelp>
    ) : embedded && props.description ? (
        <StepFieldHelp testID="restore-pairing-link-hint">{props.description}</StepFieldHelp>
    ) : null;

    if (embedded) {
        // The heading names the field, so it carries no visible label of its own (one message per state).
        return (
            <View testID="pairing-link-entry-form" style={styles.step}>
                <StepForm>
                    <StepFieldGroup>
                        {field}
                        {help}
                    </StepFieldGroup>
                </StepForm>
                <StepActions onBack={props.onBack}>
                    <StepPrimaryButton
                        testID="restore-pairing-link-submit"
                        title={props.submitLabel ?? t('common.continue')}
                        onPress={submit}
                        loading={isSubmitting}
                    />
                </StepActions>
            </View>
        );
    }

    return (
        <View testID="pairing-link-entry-form" style={styles.container}>
            <Text style={styles.title}>{props.title ?? t('connect.enterUrlManually')}</Text>
            <Text style={styles.description}>{description}</Text>
            <StepFieldGroup>
                <StepFieldLabel nativeID={LABEL_ID}>{fieldLabel}</StepFieldLabel>
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
