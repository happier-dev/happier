import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';

function resolveAuthStateSubtitle(authStatus: CliAuthStatusData | null): string {
    if (!authStatus) return t('settingsProviders.authentication.stateUnknown');
    if (authStatus.state === 'logged_in') return t('settingsProviders.authentication.stateLoggedIn');
    if (authStatus.state === 'logged_out') return t('settingsProviders.authentication.stateLoggedOut');
    return t('settingsProviders.authentication.stateUnknown');
}

function resolveAuthMethodSubtitle(method: CliAuthStatusData['method']): string | null {
    if (method === 'api_key_env') return t('settingsProviders.authentication.methods.apiKeyEnv');
    if (method === 'auth_token_env') return t('settingsProviders.authentication.methods.authTokenEnv');
    if (method === 'credentials_file') return t('settingsProviders.authentication.methods.credentialsFile');
    if (method === 'oauth_cli') return t('settingsProviders.authentication.methods.oauthCli');
    if (method === 'config_file') return t('settingsProviders.authentication.methods.configFile');
    if (method === 'gcloud_adc') return t('settingsProviders.authentication.methods.gcloudAdc');
    if (method === 'unknown') return t('settingsProviders.authentication.methods.unknown');
    return null;
}

function resolveAuthReasonSubtitle(reason: CliAuthStatusData['reason']): string | null {
    if (reason === 'missing_credentials') return t('settingsProviders.authentication.reasons.missingCredentials');
    if (reason === 'expired') return t('settingsProviders.authentication.reasons.expired');
    if (reason === 'cli_missing') return t('settingsProviders.authentication.reasons.cliMissing');
    if (reason === 'probe_failed') return t('settingsProviders.authentication.reasons.probeFailed');
    if (reason === 'timeout') return t('settingsProviders.authentication.reasons.timeout');
    if (reason === 'unsupported') return t('settingsProviders.authentication.reasons.unsupported');
    if (reason === 'interactive_blocked') return t('settingsProviders.authentication.reasons.interactiveBlocked');
    if (reason === 'not_configured') return t('settingsProviders.authentication.reasons.notConfigured');
    return null;
}

function resolveAuthSourceSubtitle(source: CliAuthStatusData['source']): string | null {
    if (source === 'env') return t('settingsProviders.authentication.sources.environment');
    if (source === 'file') return t('settingsProviders.authentication.sources.file');
    if (source === 'command') return t('settingsProviders.authentication.sources.command');
    if (source === 'mixed') return t('settingsProviders.authentication.sources.mixed');
    return null;
}

export const ProviderAuthenticationStatusRows = React.memo(function ProviderAuthenticationStatusRows(props: Readonly<{
    authStatus: CliAuthStatusData | null;
}>) {
    const { theme } = useUnistyles();
    const methodSubtitle = resolveAuthMethodSubtitle(props.authStatus?.method);
    const reasonSubtitle = resolveAuthReasonSubtitle(props.authStatus?.reason);
    const sourceSubtitle = resolveAuthSourceSubtitle(props.authStatus?.source);
    const checkedAtSubtitle =
        props.authStatus?.checkedAt && Number.isFinite(props.authStatus.checkedAt)
            ? new Date(props.authStatus.checkedAt).toLocaleString()
            : null;

    return (
        <>
            <Item
                testID="settings-provider-auth-status"
                title={t('settingsProviders.authentication.statusTitle')}
                subtitle={resolveAuthStateSubtitle(props.authStatus)}
                icon={<Ionicons name="shield-checkmark-outline" size={22} color={theme.colors.text.secondary} />}
                mode="info"
            />
            {props.authStatus?.accountLabel ? (
                <Item
                    testID="settings-provider-auth-account"
                    title={t('settingsProviders.authentication.loggedInAsTitle')}
                    subtitle={props.authStatus.accountLabel}
                    icon={<Ionicons name="person-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                    copy={props.authStatus.accountLabel}
                />
            ) : null}
            {methodSubtitle ? (
                <Item
                    testID="settings-provider-auth-method"
                    title={t('settingsProviders.authentication.methodTitle')}
                    subtitle={methodSubtitle}
                    icon={<Ionicons name="key-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {sourceSubtitle ? (
                <Item
                    testID="settings-provider-auth-source"
                    title={t('settingsProviders.authentication.sourceTitle')}
                    subtitle={sourceSubtitle}
                    icon={<Ionicons name="document-text-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {reasonSubtitle ? (
                <Item
                    testID="settings-provider-auth-reason"
                    title={t('settingsProviders.authentication.reasonTitle')}
                    subtitle={reasonSubtitle}
                    icon={<Ionicons name="alert-circle-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {checkedAtSubtitle ? (
                <Item
                    testID="settings-provider-auth-last-checked"
                    title={t('settingsProviders.authentication.lastCheckedTitle')}
                    subtitle={checkedAtSubtitle}
                    icon={<Ionicons name="time-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
        </>
    );
});
