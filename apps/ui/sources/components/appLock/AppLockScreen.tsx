import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { canUseAppLockBiometrics, readAppLockBiometricKey } from '@/auth/appLock/appLockBiometrics';
import { unlockAppLockWithDataKey, unlockAppLockWithPassword, useAppLockSnapshot } from '@/auth/appLock/appLockRuntime';
import { completeAppLockReset, requestAppLockResetCode, signOutLockedDevice } from '@/auth/appLock/appLockSetup';
import { BrandWordmark } from '@/components/onboarding/unauthShell/BrandWordmark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    APP_LOCK_MAX_PASSWORD_LENGTH,
    appLockPasswordStrengthTip,
    describeAppLockRecoveryFailure,
    validateAppLockNewPassword,
} from './appLockMessages';

type Mode = 'password' | 'resetRequest' | 'resetCode' | 'signOut';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    scrollContent: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingVertical: 32,
    },
    column: {
        width: '100%',
        maxWidth: 380,
        alignItems: 'stretch',
    },
    brand: {
        alignItems: 'center',
        gap: 14,
        marginBottom: 28,
    },
    logoMark: {
        width: 96,
        height: 96,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 8,
    },
    title: {
        fontSize: 20,
        textAlign: 'center',
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    hint: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        marginTop: -8,
        marginBottom: 14,
        ...Typography.default(),
    },
    body: {
        fontSize: 15,
        lineHeight: 21,
        textAlign: 'center',
        color: theme.colors.text.secondary,
        marginBottom: 24,
        ...Typography.default(),
    },
    label: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    input: {
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        fontSize: 16,
        color: theme.colors.input.text,
        marginBottom: 14,
        ...Typography.default(),
    },
    error: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.state.danger.foreground,
        marginBottom: 14,
        ...Typography.default(),
    },
    primaryAction: {
        marginTop: 4,
    },
    secondaryRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: 16,
        gap: 4,
    },
    dangerAction: {
        backgroundColor: theme.colors.state.danger.foreground,
    },
}));

/**
 * Full-screen lock. Covers the whole app on every platform; nothing behind it is mounted while it
 * shows. Offers the password, fingerprint (Android, when set up), an emailed reset code, and
 * signing the device out when the password is lost.
 */
export function AppLockScreen(props: Readonly<{ onSignedOut: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { record } = useAppLockSnapshot();
    const [mode, setMode] = React.useState<Mode>('password');
    const [password, setPassword] = React.useState('');
    const [code, setCode] = React.useState('');
    const [newPassword, setNewPassword] = React.useState('');
    const [confirmPassword, setConfirmPassword] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    const biometricAvailable = Boolean(record?.biometric) && canUseAppLockBiometrics();

    const goTo = React.useCallback((next: Mode) => {
        setError(null);
        setMode(next);
    }, []);

    const unlockWithFingerprint = React.useCallback(async () => {
        const key = await readAppLockBiometricKey(t('appLock.fingerprintPrompt'));
        if (key) unlockAppLockWithDataKey(key);
    }, []);

    // Offer the fingerprint once when the lock screen appears, like the system lock screen does.
    const autoPromptedRef = React.useRef(false);
    React.useEffect(() => {
        if (!biometricAvailable || autoPromptedRef.current) return;
        autoPromptedRef.current = true;
        void unlockWithFingerprint();
    }, [biometricAvailable, unlockWithFingerprint]);

    const submitPassword = React.useCallback(async () => {
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        const unlocked = await unlockAppLockWithPassword(password);
        setBusy(false);
        if (!unlocked) {
            setError(t('appLock.wrongPassword'));
            setPassword('');
        }
    }, [busy, password]);

    const sendResetCode = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        const result = await requestAppLockResetCode();
        setBusy(false);
        if (result.ok) {
            setMode('resetCode');
            return;
        }
        setError(describeAppLockRecoveryFailure(result));
    }, []);

    const submitReset = React.useCallback(async () => {
        const invalid = validateAppLockNewPassword(newPassword, confirmPassword);
        if (invalid) {
            setError(invalid);
            return;
        }
        setBusy(true);
        setError(null);
        const result = await completeAppLockReset(code.trim(), newPassword);
        setBusy(false);
        if (!result.ok) setError(describeAppLockRecoveryFailure(result));
    }, [code, confirmPassword, newPassword]);

    const confirmSignOut = React.useCallback(async () => {
        setBusy(true);
        await signOutLockedDevice();
        setBusy(false);
        props.onSignedOut();
    }, [props]);

    const title = mode === 'password'
        ? t('appLock.lockedTitle')
        : mode === 'signOut' ? t('appLock.signOutTitle') : t('appLock.resetTitle');
    const body = mode === 'password'
        ? t('appLock.lockedSubtitle')
        : mode === 'signOut'
            ? t('appLock.signOutBody')
            : mode === 'resetRequest'
                ? t('appLock.resetBody')
                : t('appLock.codeSentBody');

    return (
        <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="app-lock-screen">
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                <View style={styles.column}>
                    <View style={styles.brand} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={styles.logoMark}
                        />
                        <BrandWordmark height={40} testID="app-lock-wordmark" />
                    </View>
                    <View style={styles.titleRow}>
                        <Icon name={mode === 'signOut' ? 'sign-out' : 'lock'} size={18} color={theme.colors.text.secondary} />
                        <Text style={styles.title} accessibilityRole="header">{title}</Text>
                    </View>
                    <Text style={styles.body}>{body}</Text>

                    {mode === 'password' ? (
                        <>
                            <TextInput
                                testID="app-lock-password"
                                style={styles.input}
                                value={password}
                                onChangeText={setPassword}
                                onSubmitEditing={submitPassword}
                                placeholder={t('appLock.passwordLabel')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                accessibilityLabel={t('appLock.passwordLabel')}
                                secureTextEntry
                                autoFocus={!biometricAvailable}
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoComplete="current-password"
                                returnKeyType="go"
                            />
                            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
                            <RoundButton
                                testID="app-lock-unlock"
                                title={t('appLock.unlock')}
                                onPress={submitPassword}
                                loading={busy}
                                disabled={!password}
                                style={styles.primaryAction}
                            />
                            {biometricAvailable ? (
                                <RoundButton
                                    display="inverted"
                                    title={t('appLock.useFingerprint')}
                                    leading={<Icon name="fingerprint" size={18} color={theme.colors.text.primary} />}
                                    onPress={unlockWithFingerprint}
                                />
                            ) : null}
                            <View style={styles.secondaryRow}>
                                <RoundButton size="small" display="inverted" title={t('appLock.resetPasswordLink')} onPress={() => goTo('resetRequest')} />
                                <RoundButton size="small" display="inverted" title={t('appLock.signOutLink')} onPress={() => goTo('signOut')} />
                            </View>
                        </>
                    ) : null}

                    {mode === 'resetRequest' ? (
                        <>
                            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
                            <RoundButton title={t('appLock.sendCode')} onPress={sendResetCode} loading={busy} />
                            <View style={styles.secondaryRow}>
                                <RoundButton size="small" display="inverted" title={t('common.back')} onPress={() => goTo('password')} />
                            </View>
                        </>
                    ) : null}

                    {mode === 'resetCode' ? (
                        <>
                            <Text style={styles.label}>{t('appLock.codeLabel')}</Text>
                            <TextInput
                                testID="app-lock-reset-code"
                                style={styles.input}
                                value={code}
                                onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
                                accessibilityLabel={t('appLock.codeLabel')}
                                keyboardType="number-pad"
                                autoComplete="one-time-code"
                                textContentType="oneTimeCode"
                                maxLength={6}
                                autoFocus
                            />
                            <Text style={styles.label}>{t('appLock.newPasswordLabel')}</Text>
                            <TextInput
                                style={styles.input}
                                value={newPassword}
                                onChangeText={setNewPassword}
                                accessibilityLabel={t('appLock.newPasswordLabel')}
                                secureTextEntry
                                maxLength={APP_LOCK_MAX_PASSWORD_LENGTH}
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoComplete="new-password"
                            />
                            <Text style={styles.hint}>{appLockPasswordStrengthTip(newPassword) ?? t('appLock.passwordRules')}</Text>
                            <Text style={styles.label}>{t('appLock.confirmPasswordLabel')}</Text>
                            <TextInput
                                style={styles.input}
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                                onSubmitEditing={submitReset}
                                accessibilityLabel={t('appLock.confirmPasswordLabel')}
                                secureTextEntry
                                maxLength={APP_LOCK_MAX_PASSWORD_LENGTH}
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoComplete="new-password"
                            />
                            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
                            <RoundButton
                                title={t('appLock.setNewPassword')}
                                onPress={submitReset}
                                loading={busy}
                                disabled={code.length !== 6 || !newPassword || !confirmPassword}
                            />
                            <View style={styles.secondaryRow}>
                                <RoundButton size="small" display="inverted" title={t('appLock.resendCode')} onPress={sendResetCode} />
                                <RoundButton size="small" display="inverted" title={t('common.back')} onPress={() => goTo('password')} />
                            </View>
                        </>
                    ) : null}

                    {mode === 'signOut' ? (
                        <>
                            <RoundButton
                                testID="app-lock-sign-out-confirm"
                                title={t('appLock.signOutLink')}
                                onPress={confirmSignOut}
                                loading={busy}
                                style={styles.dangerAction}
                            />
                            <View style={styles.secondaryRow}>
                                <RoundButton size="small" display="inverted" title={t('common.cancel')} onPress={() => goTo('password')} />
                            </View>
                        </>
                    ) : null}
                </View>
            </ScrollView>
        </View>
    );
}
