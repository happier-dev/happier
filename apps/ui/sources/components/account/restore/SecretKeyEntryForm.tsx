import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { normalizeSecretKey } from '@/auth/recovery/secretKeyBackup';
import { authenticationErrorMessage } from '@/auth/flows/authenticationErrorMessage';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { StepFieldGroup, StepFieldHelp, StepFieldLabel } from '@/components/onboarding/unauthShell/StepFormParts';
import type { TextInput } from '@/components/ui/text/Text';
import { decodeBase64 } from '@/encryption/base64';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

export type SecretKeyEntrySubmitResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'invalid_key' }>
    | Readonly<{ kind: 'failed'; error?: unknown; home?: string }>
    | Readonly<{ kind: 'cancelled' }>;

export type SecretKeyEntryFormProps = Readonly<{
    description: string;
    submitTitle: string;
    onSubmit: (input: Readonly<{ normalizedKey: string; secret: Uint8Array }>) => Promise<SecretKeyEntrySubmitResult>;
    onBack?: () => void;
    /** A quieter alternative to entering the key (e.g. scanning instead), rendered with Back's weight. */
    secondaryAction?: Readonly<{ label: string; onPress: () => void }>;
}>;

const LABEL_ID = 'restore-manual-secret-label';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s16,
    },
    actions: {
        gap: theme.space.s12,
    },
}));

export const SecretKeyEntryForm = React.memo(function SecretKeyEntryForm(props: SecretKeyEntryFormProps) {
    const styles = stylesheet;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const draftRef = React.useRef('');
    const submitInFlightRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const [secretKey, setSecretKey] = React.useState('');
    const [revealed, setRevealed] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [submitPending, setSubmitPending] = React.useState(false);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            draftRef.current = '';
        };
    }, []);

    const submit = React.useCallback(async () => {
        if (submitInFlightRef.current) return;
        submitInFlightRef.current = true;
        setSubmitPending(true);
        try {
            const trimmedKey = secretKey.trim();
            if (!trimmedKey) {
                setError(t('connect.enterSecretKey'));
                inputRef.current?.focus();
                return;
            }

            let normalizedKey: string;
            let secret: Uint8Array;
            try {
                normalizedKey = normalizeSecretKey(trimmedKey);
                secret = decodeBase64(normalizedKey, 'base64url');
                if (secret.length !== 32) throw new Error('Invalid secret key length');
            } catch {
                setError(t('connect.invalidSecretKey'));
                inputRef.current?.focus();
                return;
            }

            setError(null);
            let result: SecretKeyEntrySubmitResult;
            try {
                result = await props.onSubmit({ normalizedKey, secret });
            } finally {
                secret.fill(0);
            }
            if (result.kind === 'completed') {
                draftRef.current = '';
                setSecretKey('');
                return;
            }
            if (result.kind === 'cancelled') return;
            if (result.kind === 'invalid_key') {
                setError(t('connect.invalidSecretKey'));
            } else if (result.error instanceof HappyError && result.error.kind === 'auth') {
                setError(authenticationErrorMessage(result.error, result.home));
            } else {
                setError(result.error === undefined || result.error instanceof TypeError
                    || result.error instanceof HappyError && (result.error.kind === 'network' || result.error.kind === 'server')
                    ? t('welcome.serverUnavailableTitle') : t('errors.operationFailed'));
            }
            inputRef.current?.focus();
        } finally {
            submitInFlightRef.current = false;
            if (mountedRef.current) setSubmitPending(false);
        }
    }, [props, secretKey]);

    return (
        <View style={styles.root}>
            <StepFieldGroup>
                <StepFieldLabel nativeID={LABEL_ID}>{t('connect.secretKeyInputLabel')}</StepFieldLabel>
                <FieldTextInput
                    ref={inputRef}
                    testID="restore-manual-secret-input"
                    accessibilityLabel={t('connect.secretKeyInputLabel')}
                    accessibilityLabelledBy={LABEL_ID}
                    placeholder={t('connect.secretKeyPlaceholder')}
                    value={secretKey}
                    onChangeText={(value) => {
                        draftRef.current = value;
                        setSecretKey(value);
                        if (error) setError(null);
                    }}
                    onSubmitEditing={() => {
                        void submit();
                    }}
                    invalid={error !== null}
                    secureTextEntry={!revealed}
                    multiline={false}
                    autoFocus
                    autoCapitalize="none"
                    autoComplete="off"
                    returnKeyType="go"
                    monospace
                    trailing={(
                        <IconButton
                            testID="restore-manual-secret-reveal"
                            accessibilityLabel={revealed ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                            iconName={revealed ? 'eye-slash' : 'eye'}
                            variant="plain"
                            size={28}
                            onPress={() => setRevealed((value) => !value)}
                        />
                    )}
                />
                {error ? (
                    <StepFieldHelp testID="restore-manual-secret-error" tone="error">{error}</StepFieldHelp>
                ) : (
                    <StepFieldHelp>{props.description}</StepFieldHelp>
                )}
            </StepFieldGroup>
            <View style={styles.actions}>
                <RoundButton testID="restore-manual-submit" title={props.submitTitle} action={submit} loading={submitPending} />
                {props.secondaryAction ? (
                    <RoundButton
                        testID="restore-manual-secondary"
                        title={props.secondaryAction.label}
                        display="inverted"
                        onPress={props.secondaryAction.onPress}
                    />
                ) : null}
                {props.onBack ? (
                    <RoundButton
                        testID="restore-manual-back"
                        title={t('common.back')}
                        display="inverted"
                        onPress={props.onBack}
                    />
                ) : null}
            </View>
        </View>
    );
});
