import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { OAuthBrowserHandoff } from '@/auth/flows/openExternalAuthenticationUrl';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { UnauthenticatedStep } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { asIconName } from '@/components/ui/icons/asIconName';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type OAuthBrowserWait = OAuthBrowserHandoff & Readonly<{
    providerName: string;
    badgeIconName?: string;
    destination: { kind: 'find_homes' } | { kind: 'home'; label?: string };
}>;

export function OAuthBrowserWaitStep({ wait, onBack }: Readonly<{
    wait: OAuthBrowserWait;
    onBack?: () => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const shellBack = useStepBackOverride(onBack ? () => { void onBack(); } : undefined);
    const iconName = asIconName(wait.badgeIconName) ?? 'arrow-up-right';
    const destination = wait.destination.kind === 'find_homes'
        ? t('settingsAccount.accountServiceOAuth.browserWait.findHomes')
        : wait.destination.label
            ? t('settingsAccount.accountServiceOAuth.browserWait.home', { homeName: wait.destination.label })
            : null;
    const browser = t('settingsAccount.accountServiceOAuth.browserWait.body');
    return (
        <UnauthenticatedStep
            testID="oauth-browser-wait"
            mark={<Icon name={iconName} size={ICON_SIZE.xl} color={theme.colors.text.primary} />}
            title={t('settingsAccount.accountServiceOAuth.browserWait.title', { provider: wait.providerName })}
            subtitle={destination ? `${browser}\n${destination}` : browser}
            footer={onBack && !shellBack ? (
                <WelcomeActionCard testID="oauth-browser-wait-back" title={t('common.back')}
                    iconName="arrow-left" presentation="pill" escape onPress={onBack} />
            ) : null}
        />
    );
}
