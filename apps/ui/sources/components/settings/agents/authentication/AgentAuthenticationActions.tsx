import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const AgentAuthenticationActions = React.memo(function AgentAuthenticationActions(props: Readonly<{
    canCheckNow: boolean;
    canLaunchLogin: boolean;
    loginActionKind: 'login' | 'reauthenticate';
    docsUrl?: string | null;
    onCheckNow: () => void;
    onLaunchLogin: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <>
            {props.canLaunchLogin ? (
                <Item
                    testID="settings-provider-auth-login"
                    title={props.loginActionKind === 'reauthenticate'
                        ? t('settingsAgents.authentication.reauthenticateTitle')
                        : t('settingsAgents.authentication.logInTitle')}
                    subtitle={props.loginActionKind === 'reauthenticate'
                        ? t('settingsAgents.authentication.reauthenticateSubtitle')
                        : t('settingsAgents.authentication.logInSubtitle')}
                    icon={<Icon name="sign-in" size={20} color={theme.colors.text.secondary} />}
                    onPress={props.onLaunchLogin}
                />
            ) : null}
            {props.canCheckNow ? (
                <Item
                    testID="settings-provider-auth-check-now"
                    title={t('settingsAgents.authentication.checkNowTitle')}
                    subtitle={t('settingsAgents.authentication.checkNowSubtitle')}
                    icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.text.secondary} />}
                    onPress={props.onCheckNow}
                />
            ) : null}
            {props.docsUrl ? (
                <Item
                    testID="settings-provider-auth-docs-url"
                    title={t('settingsAgents.setupGuideUrlTitle')}
                    subtitle={props.docsUrl}
                    icon={<Icon name="link" size={20} color={theme.colors.text.secondary} />}
                    mode="info"
                    copy={props.docsUrl}
                />
            ) : null}
        </>
    );
});
