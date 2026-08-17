import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { Icon } from '@/components/ui/icons/Icon';

function resolveAuthStateSubtitle(authStatus: CliAuthStatusData | null): string {
    if (!authStatus) return t('settingsAgents.authentication.stateUnknown');
    if (authStatus.state === 'logged_in') return t('settingsAgents.authentication.stateLoggedIn');
    if (authStatus.state === 'logged_out') return t('settingsAgents.authentication.stateLoggedOut');
    return t('settingsAgents.authentication.stateUnknown');
}

function resolveAuthMethodSubtitle(method: CliAuthStatusData['method']): string | null {
    if (method === 'api_key_env') return t('settingsAgents.authentication.methods.apiKeyEnv');
    if (method === 'auth_token_env') return t('settingsAgents.authentication.methods.authTokenEnv');
    if (method === 'credentials_file') return t('settingsAgents.authentication.methods.credentialsFile');
    if (method === 'oauth_cli') return t('settingsAgents.authentication.methods.oauthCli');
    if (method === 'config_file') return t('settingsAgents.authentication.methods.configFile');
    if (method === 'gcloud_adc') return t('settingsAgents.authentication.methods.gcloudAdc');
    if (method === 'unknown') return t('settingsAgents.authentication.methods.unknown');
    return null;
}

function resolveAuthReasonSubtitle(reason: CliAuthStatusData['reason']): string | null {
    if (reason === 'missing_credentials') return t('settingsAgents.authentication.reasons.missingCredentials');
    if (reason === 'expired') return t('settingsAgents.authentication.reasons.expired');
    if (reason === 'cli_missing') return t('settingsAgents.authentication.reasons.cliMissing');
    if (reason === 'probe_failed') return t('settingsAgents.authentication.reasons.probeFailed');
    if (reason === 'timeout') return t('settingsAgents.authentication.reasons.timeout');
    if (reason === 'unsupported') return t('settingsAgents.authentication.reasons.unsupported');
    if (reason === 'interactive_blocked') return t('settingsAgents.authentication.reasons.interactiveBlocked');
    if (reason === 'not_configured') return t('settingsAgents.authentication.reasons.notConfigured');
    return null;
}

function resolveAuthSourceSubtitle(source: CliAuthStatusData['source']): string | null {
    if (source === 'env') return t('settingsAgents.authentication.sources.environment');
    if (source === 'file') return t('settingsAgents.authentication.sources.file');
    if (source === 'command') return t('settingsAgents.authentication.sources.command');
    if (source === 'mixed') return t('settingsAgents.authentication.sources.mixed');
    return null;
}

export const AgentAuthenticationStatusRows = React.memo(function AgentAuthenticationStatusRows(props: Readonly<{
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
                title={t('settingsAgents.authentication.statusTitle')}
                subtitle={resolveAuthStateSubtitle(props.authStatus)}
                icon={<Icon name="shield-check" size={20} color={theme.colors.text.secondary} />}
                mode="info"
            />
            {props.authStatus?.accountLabel ? (
                <Item
                    testID="settings-provider-auth-account"
                    title={t('settingsAgents.authentication.loggedInAsTitle')}
                    subtitle={props.authStatus.accountLabel}
                    icon={<Icon name="person" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                    copy={props.authStatus.accountLabel}
                />
            ) : null}
            {methodSubtitle ? (
                <Item
                    testID="settings-provider-auth-method"
                    title={t('settingsAgents.authentication.methodTitle')}
                    subtitle={methodSubtitle}
                    icon={<Icon name="key" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {sourceSubtitle ? (
                <Item
                    testID="settings-provider-auth-source"
                    title={t('settingsAgents.authentication.sourceTitle')}
                    subtitle={sourceSubtitle}
                    icon={<Icon name="file-text" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {reasonSubtitle ? (
                <Item
                    testID="settings-provider-auth-reason"
                    title={t('settingsAgents.authentication.reasonTitle')}
                    subtitle={reasonSubtitle}
                    icon={<Icon name="warning-circle" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
            {checkedAtSubtitle ? (
                <Item
                    testID="settings-provider-auth-last-checked"
                    title={t('settingsAgents.authentication.lastCheckedTitle')}
                    subtitle={checkedAtSubtitle}
                    icon={<Icon name="clock" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                />
            ) : null}
        </>
    );
});
