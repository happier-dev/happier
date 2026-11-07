import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Text } from '@/components/ui/text/Text';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import { t } from '@/text';
import type { DaemonNpmRegistryProfileMutationResponseV1 } from '@happier-dev/protocol/rpc/npmRegistryProfiles';

type BrowserLogin = Extract<DaemonNpmRegistryProfileMutationResponseV1, { status: 'browser_login_required' }>;
type BrowserAttempt = { login: BrowserLogin; controller: AbortController; pending: boolean };

/** One private entry for Credentials, Connect and Plugins; material never becomes an Action operand. */
export function RegistryCredentialEditor(props: Readonly<{
    disabled: boolean;
    onSave: (secret: string) => Promise<boolean | void>;
    onMachineLogin: () => Promise<boolean | void>;
    onStartBrowserLogin: () => Promise<BrowserLogin | undefined>;
    onCompleteBrowserLogin: (loginId: string, signal: AbortSignal) => Promise<boolean | void>;
    onCancelBrowserLogin: (loginId: string) => Promise<unknown>;
    onOpenBrowserLogin: (url: string) => Promise<unknown>;
    onCancel: () => void;
}>) {
    const { theme } = useUnistyles();
    const [secret, setSecret] = React.useState('');
    const [browserLogin, setBrowserLogin] = React.useState<BrowserLogin | null>(null);
    const browserAttempt = React.useRef<BrowserAttempt | null>(null);
    const mounted = React.useRef(true);
    const latest = React.useRef(props);
    latest.current = props;
    const cancelBrowser = React.useCallback(() => {
        const attempt = browserAttempt.current;
        browserAttempt.current = null;
        if (!attempt) return;
        attempt.controller.abort();
        // The running completion Action owns abort cleanup. A failed idle
        // attempt still needs the public cancel Action for its retained handle.
        if (!attempt.pending) void latest.current.onCancelBrowserLogin(attempt.login.loginId);
    }, []);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; cancelBrowser(); };
    }, [cancelBrowser]);
    const finishBrowser = async (attempt: BrowserAttempt) => {
        let connected: boolean | void;
        try { connected = await latest.current.onCompleteBrowserLogin(attempt.login.loginId, attempt.controller.signal); }
        finally { attempt.pending = false; }
        if (browserAttempt.current !== attempt || attempt.controller.signal.aborted || !connected) return;
        browserAttempt.current = null;
        setBrowserLogin(null);
        latest.current.onCancel();
    };
    const startBrowser = async () => {
        const login = await latest.current.onStartBrowserLogin();
        if (!login) return;
        if (!mounted.current) { void latest.current.onCancelBrowserLogin(login.loginId); return; }
        const attempt = { login, controller: new AbortController(), pending: true };
        browserAttempt.current = attempt;
        setBrowserLogin(login);
        await finishBrowser(attempt);
    };
    const cancel = () => { cancelBrowser(); setSecret(''); props.onCancel(); };
    return <SectionContentRow>
        <Text variant="body" style={{ color: theme.colors.text.secondary }} testID="npm-registry:material-visibility">
            {describeDirectDeliveryVisibility(readDirectDeliveryVisibility())}
        </Text>
        {browserLogin ? <>
            <Text variant="body">{t('connectedServicesSettings.deviceWaitingFor', { service: 'npm' })}</Text>
            <Text variant="meta" selectable>{browserLogin.loginUrl}</Text>
            <SectionButtonRow>
                <RoundButton testID="npm-registry:login-browser-open" size="small"
                    title={t('connectedServicesSettings.deviceOpenService', { service: 'npm' })}
                    onPress={() => { void props.onOpenBrowserLogin(browserLogin.loginUrl); }} />
                <RoundButton testID="npm-registry:login-browser-retry" size="small" display="secondary"
                    title={t('common.retry')} disabled={props.disabled} onPress={() => {
                        const attempt = { login: browserLogin, controller: new AbortController(), pending: true };
                        browserAttempt.current = attempt;
                        void finishBrowser(attempt);
                    }} />
            </SectionButtonRow>
        </> : <>
        <SectionButtonRow>
            <RoundButton testID="npm-registry:login-machine" size="small" display="secondary"
                title={t('settingsPlugins.registriesLoginMachine')} disabled={props.disabled}
                onPress={() => { void props.onMachineLogin().then((connected) => { if (connected) cancel(); }); }} />
            <RoundButton testID="npm-registry:login-browser" size="small" display="secondary"
                title={t('settingsPlugins.registriesLoginBrowser')} disabled={props.disabled}
                onPress={() => { void startBrowser(); }} />
        </SectionButtonRow>
        <FieldTextInput testID="settings.plugins.registries.login.token"
            accessibilityLabel={t('settingsPlugins.registriesLoginTitle')}
            placeholder={t('settingsPlugins.registriesLoginBody')}
            value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" editable={!props.disabled} />
        </>}
        <SectionButtonRow>
            {!browserLogin ?
            <RoundButton testID="settings.plugins.registries.login.save" title={t('settingsPlugins.registriesLogin')}
                size="small" disabled={props.disabled || !secret.trim()} onPress={() => { void (async () => {
                    if (await props.onSave(secret.trim())) { setSecret(''); props.onCancel(); }
                })(); }} /> : null}
            <RoundButton testID="settings.plugins.registries.login.cancel" title={t('common.cancel')}
                display="secondary" size="small" disabled={props.disabled && !browserLogin} onPress={cancel} />
        </SectionButtonRow>
    </SectionContentRow>;
}
