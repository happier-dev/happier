import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export const ProviderAuthenticationActions = React.memo(function ProviderAuthenticationActions(props: Readonly<{
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
                        ? t('settingsProviders.authentication.reauthenticateTitle')
                        : t('settingsProviders.authentication.logInTitle')}
                    subtitle={props.loginActionKind === 'reauthenticate'
                        ? t('settingsProviders.authentication.reauthenticateSubtitle')
                        : t('settingsProviders.authentication.logInSubtitle')}
                    icon={<Ionicons name="log-in-outline" size={22} color={theme.colors.text.secondary} />}
                    onPress={props.onLaunchLogin}
                />
            ) : null}
            {props.canCheckNow ? (
                <Item
                    testID="settings-provider-auth-check-now"
                    title={t('settingsProviders.authentication.checkNowTitle')}
                    subtitle={t('settingsProviders.authentication.checkNowSubtitle')}
                    icon={<Ionicons name="refresh-outline" size={22} color={theme.colors.text.secondary} />}
                    onPress={props.onCheckNow}
                />
            ) : null}
            {props.docsUrl ? (
                <Item
                    testID="settings-provider-auth-docs-url"
                    title={t('settingsProviders.setupGuideUrlTitle')}
                    subtitle={props.docsUrl}
                    icon={<Ionicons name="link-outline" size={22} color={theme.colors.text.secondary} />}
                    mode="info"
                    copy={props.docsUrl}
                />
            ) : null}
        </>
    );
});
