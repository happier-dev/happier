import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { normalizeSecretKey } from '@/auth/recovery/secretKeyBackup';
import { authenticationErrorMessage } from '@/auth/flows/authenticationErrorMessage';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { StepFieldHelp, StepQuietAction } from '@/components/onboarding/unauthShell/StepFormParts';
import { StepActions } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { StepPrimaryButton, useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { useUnauthShellLayout } from '@/components/onboarding/unauthShell/useUnauthShellLayout';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import type { TextInput } from '@/components/ui/text/Text';
import { decodeBase64 } from '@/encryption/base64';

import { RecoveryKeyCells } from './RecoveryKeyCells';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

export type SecretKeyEntrySubmitResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'invalid_key' }>
    | Readonly<{ kind: 'failed'; error?: unknown; home?: string }>
    | Readonly<{ kind: 'cancelled' }>;

export type SecretKeyEntryFormProps = Readonly<{
    /** One line under the key saying what it is for, when the host's heading does not already say it. */
    description?: string;
    submitTitle: string;
    onSubmit: (input: Readonly<{ normalizedKey: string; secret: Uint8Array }>) => Promise<SecretKeyEntrySubmitResult>;
    onBack?: () => void;
    /** A quieter way on, under the actions (Lost your key?, scanning instead). */
    secondaryAction?: Readonly<{ label: string; onPress: () => void; testID?: string }>;
    /** Focus the key on arrival (default). A host offering several ways focuses only the first. */
    autoFocus?: boolean;
}>;

const DESCRIPTION_ID = 'restore-manual-secret-help';
/** A typed character before the person asks to see the key: the key never reaches the page's text unasked. */
const MASK = '•';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        alignItems: 'center',
        gap: theme.space.s24,
    },
    help: {
        alignItems: 'center',
    },
    actions: {
        width: '100%',
        alignItems: 'center',
        gap: theme.space.s16,
    },
}));

/**
 * The one recovery-key entry (lab direction A "Your recovery key"): the key as the printed key's cells, the clipboard
 * one press away while it is empty (then the choice to show it), the step's Sign in with Back to its left, and a quiet
 * way on. The key stays masked until the person shows it.
 */
export const SecretKeyEntryForm = React.memo(function SecretKeyEntryForm(props: SecretKeyEntryFormProps) {
    const styles = stylesheet;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const submitInFlightRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const [secretKey, setSecretKey] = React.useState('');
    const [revealed, setRevealed] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [submitPending, setSubmitPending] = React.useState(false);
    const compact = useUnauthShellLayout() === 'compact';
    const onBack = useEventCallback(() => props.onBack?.());
    useStepBackOverride(props.onBack ? onBack : undefined);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const changeKey = React.useCallback((value: string) => {
        setSecretKey(value);
        setError(null);
    }, []);

    const pasteFromClipboard = React.useCallback(async () => {
        const pasted = await getClipboardStringTrimmedSafe();
        if (!mountedRef.current || !pasted) return;
        changeKey(pasted);
    }, [changeKey]);

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
                setSecretKey('');
                return;
            }
            if (result.kind === 'cancelled') return;
            if (result.kind === 'invalid_key') {
                setError(t('connect.invalidSecretKey'));
            } else if (result.error instanceof HappyError && result.error.kind === 'auth') {
                setError(authenticationErrorMessage(result.error, result.home));
            } else {
                setError(result.error instanceof TypeError
                    || result.error instanceof HappyError && (result.error.kind === 'network' || result.error.kind === 'server')
                    ? t('welcome.serverUnavailableTitle') : t('errors.operationFailed'));
            }
            inputRef.current?.focus();
        } finally {
            submitInFlightRef.current = false;
            if (mountedRef.current) setSubmitPending(false);
        }
    }, [props, secretKey]);

    const shown = revealed ? secretKey : secretKey.replace(/[^\s-]/gu, MASK);
    const helpLine = error
        ? <StepFieldHelp testID="restore-manual-secret-error" nativeID={DESCRIPTION_ID} tone="error">{error}</StepFieldHelp>
        : props.description
            ? <StepFieldHelp nativeID={DESCRIPTION_ID}>{props.description}</StepFieldHelp>
            : null;

    return (
        <View style={styles.root}>
            <RecoveryKeyCells
                ref={inputRef}
                testID="restore-manual-secret-input"
                accessibilityLabel={t('connect.secretKeyInputLabel')}
                accessibilityDescribedBy={helpLine ? DESCRIPTION_ID : undefined}
                value={secretKey}
                shown={shown}
                onChangeText={changeKey}
                onSubmitEditing={() => { void submit(); }}
                invalid={error !== null}
                secureTextEntry={!revealed}
                autoFocus={props.autoFocus !== false}
                groupsPerRow={compact ? 2 : 3}
            />
            {helpLine ? <View style={styles.help}>{helpLine}</View> : null}
            <View style={styles.actions}>
                {/* One slot: the clipboard while the key is empty, then the choice to show what was entered. */}
                {secretKey.length === 0 ? (
                    <WelcomeActionCard
                        testID="restore-manual-paste"
                        presentation="pill"
                        iconName="clipboard"
                        title={t('connect.pasteFromClipboard')}
                        escape
                        onPress={() => { void pasteFromClipboard(); }}
                    />
                ) : (
                    <WelcomeActionCard
                        testID="restore-manual-secret-reveal"
                        presentation="pill"
                        iconName={revealed ? 'eye-slash' : 'eye'}
                        title={revealed ? t('settingsAccount.hideRecoveryKey') : t('settingsAccount.showRecoveryKey')}
                        escape
                        onPress={() => setRevealed((value) => !value)}
                    />
                )}
                <StepActions onBack={props.onBack ? onBack : undefined}>
                    <StepPrimaryButton
                        testID="restore-manual-submit"
                        title={props.submitTitle}
                        onPress={submit}
                        loading={submitPending}
                    />
                    {props.secondaryAction ? (
                        <StepQuietAction
                            testID={props.secondaryAction.testID ?? 'restore-manual-secondary'}
                            label={props.secondaryAction.label}
                            onPress={props.secondaryAction.onPress}
                        />
                    ) : null}
                </StepActions>
            </View>
        </View>
    );
});
