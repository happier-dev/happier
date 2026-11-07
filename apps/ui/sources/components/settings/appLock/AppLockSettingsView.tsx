import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AppLockMailSecurity, AppLockMailSettings } from '@happier-dev/protocol';

import { canUseAppLockBiometrics } from '@/auth/appLock/appLockBiometrics';
import { APP_LOCK_AUTO_LOCK_CHOICES, type AppLockRecord } from '@/auth/appLock/appLockRecord';
import { getAppLockSnapshot, lockAppLock, useAppLockSnapshot, verifyAppLockPassword } from '@/auth/appLock/appLockRuntime';
import {
    changeAppLockEmail,
    changeAppLockPassword,
    enableAppLock,
    setAppLockAutoLockMinutes,
    setAppLockBiometricEnabled,
    turnOffAppLock,
} from '@/auth/appLock/appLockSetup';
import {
    APP_LOCK_MAX_PASSWORD_LENGTH,
    appLockPasswordStrengthTip,
    describeAppLockRecoveryFailure,
    isPlausibleEmail,
    validateAppLockNewPassword,
} from '@/components/appLock/appLockMessages';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    apiAppLockMailSettingsGet,
    apiAppLockMailSettingsSave,
    apiAppLockMailSettingsSendTest,
} from '@/sync/api/appLock/apiAppLockRecovery';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    form: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 20,
        gap: 14,
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
    },
    input: {
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 16,
        color: theme.colors.input.text,
        ...Typography.default(),
    },
    hint: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    error: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.state.danger.foreground,
        ...Typography.default(),
    },
    actionsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        justifyContent: 'center',
    },
}));

const MAIL_SECURITY_CHOICES: readonly AppLockMailSecurity[] = ['tls', 'starttls', 'none'];
const DEFAULT_PORT_BY_SECURITY: Readonly<Record<AppLockMailSecurity, number>> = { tls: 465, starttls: 587, none: 25 };

type MailState = Readonly<{ status: 'loading' | 'ready' | 'error'; settings: AppLockMailSettings | null }>;

function describeAutoLock(minutes: number | null): string {
    if (minutes === null) return t('appLock.lockAfterLaunchOnly');
    if (minutes === 0) return t('appLock.lockAfterImmediately');
    return t('appLock.lockAfterMinutes', { count: minutes });
}

function describeMailSecurity(security: AppLockMailSecurity): string {
    if (security === 'tls') return t('appLock.mailSecurityTls');
    if (security === 'starttls') return t('appLock.mailSecurityStartTls');
    return t('appLock.mailSecurityNone');
}

async function promptPassword(title: string, message: string): Promise<string | null> {
    const value = await Modal.prompt(title, message, { inputType: 'secure-text', confirmText: t('common.continue') });
    return value ? value : null;
}

async function confirmRecoverySettingsChange(title: string): Promise<boolean> {
    if (getAppLockSnapshot().status === 'disabled') return true;
    const current = await promptPassword(title, t('appLock.currentPasswordPrompt'));
    if (!current) return false;
    if (await verifyAppLockPassword(current)) return true;
    Modal.alert(t('common.error'), t('appLock.wrongPassword'));
    return false;
}

/**
 * Settings › App lock. The email server (shared by the account) sends password reset codes; the
 * lock itself is per device. Every change that weakens the lock asks for the current password.
 */
export function AppLockSettingsView() {
    const { status, record } = useAppLockSnapshot();
    const featureEnabled = useFeatureEnabled('appLock.emailRecovery');
    const [mail, setMail] = React.useState<MailState>({ status: 'loading', settings: null });

    React.useEffect(() => {
        if (!featureEnabled) return;
        let active = true;
        void apiAppLockMailSettingsGet().then((result) => {
            if (!active) return;
            setMail(result.ok ? { status: 'ready', settings: result.settings } : { status: 'error', settings: null });
        });
        return () => {
            active = false;
        };
    }, [featureEnabled]);

    const onMailSaved = React.useCallback((settings: AppLockMailSettings) => {
        setMail({ status: 'ready', settings });
    }, []);

    if (!featureEnabled) {
        return (
            <ItemList>
                <IntroGroup subtitle={t('appLock.featureUnavailable')} />
            </ItemList>
        );
    }

    const unlocked = status === 'unlocked' && record !== null;
    const mailSection = <MailServerSection mail={mail} onSaved={onMailSaved} />;
    return (
        <ItemList>
            {unlocked ? (
                <ManageAppLock record={record} recoveryEmail={mail.settings?.recoveryEmail ?? record.email} onEmailChanged={(recoveryEmail) => {
                    if (mail.settings) onMailSaved({ ...mail.settings, recoveryEmail });
                }} />
            ) : (
                <>
                    <IntroGroup subtitle={t('appLock.settingsSubtitleOff')} />
                    <EnableAppLock mailReady={mail.settings !== null} recoveryEmail={mail.settings?.recoveryEmail ?? null} />
                </>
            )}
            {mailSection}
        </ItemList>
    );
}

function IntroGroup(props: Readonly<{ subtitle: string }>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup footer={t('appLock.settingsIntro')}>
            <Item
                title={t('appLock.settingsTitle')}
                subtitle={props.subtitle}
                subtitleLines={0}
                icon={<Icon name="lock" size={29} color={theme.colors.accent.blue} />}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
}

function MailServerSection(props: Readonly<{
    mail: MailState;
    onSaved: (settings: AppLockMailSettings) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const saved = props.mail.settings;
    const [host, setHost] = React.useState('');
    const [port, setPort] = React.useState('');
    const [security, setSecurity] = React.useState<AppLockMailSecurity>('starttls');
    const [username, setUsername] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [fromAddress, setFromAddress] = React.useState('');
    const [recoveryEmail, setRecoveryEmail] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    // Fill the form once the saved settings arrive; later edits stay local until saved.
    const filledRef = React.useRef(false);
    React.useEffect(() => {
        if (filledRef.current || props.mail.status !== 'ready') return;
        filledRef.current = true;
        if (!saved) return;
        setHost(saved.host);
        setPort(String(saved.port));
        setSecurity(saved.security);
        setUsername(saved.username);
        setFromAddress(saved.fromAddress);
        setRecoveryEmail(saved.recoveryEmail ?? '');
    }, [props.mail.status, saved]);

    // The guarded Change email action updates this same account-wide recipient.
    React.useEffect(() => {
        setRecoveryEmail(saved?.recoveryEmail ?? '');
    }, [saved?.recoveryEmail]);

    // Follow the usual port for the chosen security unless the user typed a custom one.
    const chooseSecurity = React.useCallback((next: AppLockMailSecurity) => {
        setPort((currentPort) => (!currentPort || currentPort === String(DEFAULT_PORT_BY_SECURITY[security])
            ? String(DEFAULT_PORT_BY_SECURITY[next])
            : currentPort));
        setSecurity(next);
    }, [security]);

    const save = React.useCallback(async () => {
        const portNumber = Number(port || DEFAULT_PORT_BY_SECURITY[security]);
        if (!isPlausibleEmail(recoveryEmail) || !host.trim() || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 || fromAddress.trim().length < 3) {
            setError(t('appLock.mailInvalid'));
            return;
        }
        if (!(await confirmRecoverySettingsChange(t('appLock.mailSave')))) return;
        setBusy(true);
        setError(null);
        const input = {
            recoveryEmail: recoveryEmail.trim(),
            host: host.trim(),
            port: portNumber,
            security,
            username: username.trim(),
            fromAddress: fromAddress.trim(),
            ...(password ? { password } : {}),
        };
        const result = await apiAppLockMailSettingsSave(input);
        setBusy(false);
        if (!result.ok) {
            setError(describeAppLockRecoveryFailure(result));
            return;
        }
        setPassword('');
        setPort(String(portNumber));
        props.onSaved({
            recoveryEmail: input.recoveryEmail,
            host: input.host,
            port: input.port,
            security: input.security,
            username: input.username,
            fromAddress: input.fromAddress,
            hasPassword: password ? true : (saved?.hasPassword ?? false),
        });
        Modal.alert(t('appLock.mailTitle'), t('appLock.mailSaved'));
    }, [fromAddress, host, password, port, props, recoveryEmail, saved?.hasPassword, security, username]);

    const sendTest = React.useCallback(async () => {
        const to = saved?.recoveryEmail ?? '';
        if (!saved || !isPlausibleEmail(to)) return;
        const result = await apiAppLockMailSettingsSendTest();
        Modal.alert(result.ok ? t('appLock.mailTitle') : t('common.error'), result.ok
            ? t('appLock.mailTestSent', { email: to })
            : describeAppLockRecoveryFailure(result));
    }, [saved]);

    return (
        <>
            <ItemGroup title={t('appLock.mailTitle')} footer={t('appLock.mailFooter')}>
                <Item
                    title={t('appLock.mailTitle')}
                    subtitle={props.mail.status === 'loading'
                        ? t('appLock.mailStatusLoading')
                        : saved ? `${saved.host}:${saved.port}` : t('appLock.mailStatusNotSet')}
                    icon={<Icon name="envelope" size={29} color={theme.colors.accent.indigo} />}
                    mode="info"
                    showChevron={false}
                />
                {MAIL_SECURITY_CHOICES.map((choice) => {
                    const selected = security === choice;
                    return (
                        <Item
                            key={choice}
                            title={describeMailSecurity(choice)}
                            selected={selected}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                            rightElement={selected ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => chooseSecurity(choice)}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>
            <View style={styles.form}>
                <FieldItem label={t('appLock.emailLabel')} supportingText={t('appLock.emailHint')}>
                    <TextInput testID="app-lock-settings-email" style={styles.input} value={recoveryEmail} onChangeText={setRecoveryEmail}
                        accessibilityLabel={t('appLock.emailLabel')} keyboardType="email-address"
                        autoCapitalize="none" autoCorrect={false} autoComplete="email" />
                </FieldItem>
                <FieldItem label={t('appLock.mailHost')}>
                    <TextInput testID="app-lock-mail-host" style={styles.input} value={host} onChangeText={setHost}
                        accessibilityLabel={t('appLock.mailHost')}
                        autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                </FieldItem>
                <FieldItem label={t('appLock.mailPort')}>
                    <TextInput testID="app-lock-mail-port" style={styles.input} value={port}
                        onChangeText={(value) => setPort(value.replace(/\D/g, '').slice(0, 5))}
                        accessibilityLabel={t('appLock.mailPort')} placeholder={String(DEFAULT_PORT_BY_SECURITY[security])}
                        placeholderTextColor={theme.colors.input.placeholder} keyboardType="number-pad" />
                </FieldItem>
                <FieldItem label={t('appLock.mailUsername')}>
                    <TextInput testID="app-lock-mail-username" style={styles.input} value={username} onChangeText={setUsername}
                        accessibilityLabel={t('appLock.mailUsername')} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
                </FieldItem>
                <FieldItem label={t('appLock.mailPassword')} supportingText={saved?.hasPassword ? t('appLock.mailPasswordSaved') : undefined}>
                    <TextInput testID="app-lock-mail-password" style={styles.input} value={password} onChangeText={setPassword}
                        accessibilityLabel={t('appLock.mailPassword')} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" />
                </FieldItem>
                <FieldItem label={t('appLock.mailFrom')} supportingText={t('appLock.mailFromHint')}>
                    <TextInput testID="app-lock-mail-from" style={styles.input} value={fromAddress} onChangeText={setFromAddress}
                        accessibilityLabel={t('appLock.mailFrom')}
                        autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
                </FieldItem>
                {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
                <RoundButton testID="app-lock-mail-save" title={t('appLock.mailSave')} onPress={save} loading={busy} disabled={!host || !fromAddress} />
                <View style={styles.actionsRow}>
                    <RoundButton testID="app-lock-mail-test" size="small" display="inverted"
                        title={t('appLock.mailTest')} onPress={sendTest}
                        disabled={!saved || busy || !isPlausibleEmail(saved.recoveryEmail ?? '')} />
                </View>
            </View>
        </>
    );
}

function EnableAppLock(props: Readonly<{ mailReady: boolean; recoveryEmail: string | null }>) {
    const styles = stylesheet;
    const [password, setPassword] = React.useState('');
    const [confirmPassword, setConfirmPassword] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const strengthTip = appLockPasswordStrengthTip(password);

    const turnOn = React.useCallback(async () => {
        const email = props.recoveryEmail ?? '';
        if (!isPlausibleEmail(email)) {
            setError(t('appLock.invalidEmail'));
            return;
        }
        const invalid = validateAppLockNewPassword(password, confirmPassword);
        if (invalid) {
            setError(invalid);
            return;
        }
        setBusy(true);
        setError(null);
        const result = await enableAppLock({ email, password });
        setBusy(false);
        if (!result.ok) {
            setError(describeAppLockRecoveryFailure(result));
            return;
        }
        setPassword('');
        setConfirmPassword('');
        Modal.alert(t('appLock.settingsTitle'), t('appLock.turnedOn'));
    }, [confirmPassword, password, props.recoveryEmail]);

    return (
        <ItemGroup title={t('appLock.turnOnTitle')}>
            <View style={styles.form}>
                <FieldItem label={t('appLock.newPasswordLabel')} supportingText={strengthTip ?? t('appLock.passwordRules')}>
                    <TextInput testID="app-lock-settings-password" style={styles.input} value={password} onChangeText={setPassword}
                        accessibilityLabel={t('appLock.newPasswordLabel')} secureTextEntry maxLength={APP_LOCK_MAX_PASSWORD_LENGTH}
                        autoCapitalize="none" autoCorrect={false} autoComplete="new-password" />
                </FieldItem>
                <FieldItem label={t('appLock.confirmPasswordLabel')}>
                    <TextInput testID="app-lock-settings-confirm" style={styles.input} value={confirmPassword}
                        onChangeText={setConfirmPassword} onSubmitEditing={turnOn}
                        accessibilityLabel={t('appLock.confirmPasswordLabel')} secureTextEntry maxLength={APP_LOCK_MAX_PASSWORD_LENGTH}
                        autoCapitalize="none" autoCorrect={false} autoComplete="new-password" />
                </FieldItem>
                {!props.mailReady ? <Text style={styles.hint}>{t('appLock.mailRequired')}</Text> : null}
                {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
                <RoundButton
                    testID="app-lock-settings-turn-on"
                    title={t('appLock.turnOn')}
                    onPress={turnOn}
                    loading={busy}
                    disabled={!props.mailReady || !isPlausibleEmail(props.recoveryEmail ?? '') || !password || !confirmPassword}
                />
            </View>
        </ItemGroup>
    );
}

function ManageAppLock(props: Readonly<{ record: AppLockRecord; recoveryEmail: string; onEmailChanged: (email: string) => void }>) {
    const { theme } = useUnistyles();
    const { record } = props;
    const biometricsAvailable = canUseAppLockBiometrics();

    const changePassword = React.useCallback(async () => {
        const current = await promptPassword(t('appLock.changePassword'), t('appLock.currentPasswordPrompt'));
        if (!current) return;
        if (!(await verifyAppLockPassword(current))) {
            Modal.alert(t('common.error'), t('appLock.wrongPassword'));
            return;
        }
        const next = await promptPassword(t('appLock.changePassword'), `${t('appLock.newPasswordPrompt')}\n\n${t('appLock.passwordRules')} ${t('appLock.passwordTip')}`);
        if (!next) return;
        const confirmation = await promptPassword(t('appLock.changePassword'), t('appLock.confirmPasswordPrompt'));
        if (confirmation === null) return;
        const invalid = validateAppLockNewPassword(next, confirmation);
        if (invalid) {
            Modal.alert(t('common.error'), invalid);
            return;
        }
        const changed = await changeAppLockPassword(current, next);
        Modal.alert(t('appLock.settingsTitle'), changed ? t('appLock.passwordChanged') : t('appLock.wrongPassword'));
    }, []);

    const changeEmail = React.useCallback(async () => {
        if (!(await confirmRecoverySettingsChange(t('appLock.changeEmail')))) return;
        const email = await Modal.prompt(t('appLock.changeEmail'), t('appLock.newEmailPrompt'), {
            inputType: 'email-address',
            defaultValue: props.recoveryEmail,
            confirmText: t('common.save'),
        });
        if (!email) return;
        if (!isPlausibleEmail(email)) {
            Modal.alert(t('common.error'), t('appLock.invalidEmail'));
            return;
        }
        const result = await changeAppLockEmail(email);
        if (result.ok) props.onEmailChanged(email.trim());
        Modal.alert(result.ok ? t('appLock.settingsTitle') : t('common.error'), result.ok
            ? t('appLock.emailChanged')
            : describeAppLockRecoveryFailure(result));
    }, [props]);

    const turnOff = React.useCallback(async () => {
        const current = await promptPassword(t('appLock.turnOff'), t('appLock.turnOffPrompt'));
        if (!current) return;
        const turnedOff = await turnOffAppLock(current);
        Modal.alert(turnedOff ? t('appLock.settingsTitle') : t('common.error'), turnedOff ? t('appLock.turnedOff') : t('appLock.wrongPassword'));
    }, []);

    const toggleFingerprint = React.useCallback(async (enabled: boolean) => {
        const ok = await setAppLockBiometricEnabled(enabled, t('appLock.fingerprintPrompt'));
        if (!ok && enabled) Modal.alert(t('common.error'), t('appLock.fingerprintFailed'));
    }, []);

    return (
        <>
            <ItemGroup footer={t('appLock.manageFooter')}>
                <Item
                    testID="app-lock-settings-lock-now"
                    title={t('appLock.lockNow')}
                    subtitle={t('appLock.settingsSubtitleOn')}
                    icon={<Icon name="lock" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => lockAppLock()}
                    showChevron={false}
                />
                <Item
                    testID="app-lock-change-email"
                    title={t('appLock.changeEmail')}
                    subtitle={props.recoveryEmail}
                    icon={<Icon name="envelope" size={29} color={theme.colors.accent.indigo} />}
                    onPress={changeEmail}
                />
                <Item
                    title={t('appLock.changePassword')}
                    icon={<Icon name="key" size={29} color={theme.colors.accent.purple} />}
                    onPress={changePassword}
                />
                {biometricsAvailable ? (
                    <Item
                        title={t('appLock.fingerprintTitle')}
                        subtitle={t('appLock.fingerprintSubtitle')}
                        icon={<Icon name="fingerprint" size={29} color={theme.colors.accent.green} />}
                        rightElement={<Switch value={record.biometric} onValueChange={(value) => void toggleFingerprint(Boolean(value))} />}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            <ItemGroup title={t('appLock.lockAfterTitle')} footer={t('appLock.lockAfterFooter')}>
                {APP_LOCK_AUTO_LOCK_CHOICES.map((minutes) => {
                    const selected = record.autoLockMinutes === minutes;
                    return (
                        <Item
                            key={String(minutes)}
                            title={describeAutoLock(minutes)}
                            selected={selected}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                            rightElement={selected ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => void setAppLockAutoLockMinutes(minutes)}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>
            <ItemGroup>
                <Item
                    testID="app-lock-settings-turn-off"
                    title={t('appLock.turnOff')}
                    icon={<Icon name="lock" size={29} color={theme.colors.state.danger.foreground} />}
                    onPress={turnOff}
                    destructive
                    showChevron={false}
                />
            </ItemGroup>
        </>
    );
}
