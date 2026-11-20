import * as React from 'react';

import type { OAuthBrowserHandoff } from '@/auth/flows/openExternalAuthenticationUrl';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { UnauthenticatedStep } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { asIconName } from '@/components/ui/icons/asIconName';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
            mark={<StepMark iconName={iconName} />}
            title={t('settingsAccount.accountServiceOAuth.browserWait.title', { provider: wait.providerName })}
            subtitle={browser}
            footer={onBack && !shellBack ? (
                <WelcomeActionCard testID="oauth-browser-wait-back" title={t('common.back')}
                    iconName="arrow-left" presentation="pill" escape onPress={onBack} />
            ) : null}
        >
            {/* The wait itself, as the step's one door-width notice: it breathes while the browser finishes (lab
                direction A "Finish on … SSO"), and says where the person comes back to. */}
            <SurfaceStateCard testID="oauth-browser-wait-status" size="line" lineLayout="notice" kind="loading"
                title={t('settingsAccount.accountServiceOAuth.stages.signingIn')}
                reason={destination ?? undefined} accessibilitySemantics="status" />
        </UnauthenticatedStep>
    );
}
