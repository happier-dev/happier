import * as React from 'react';
import { AccountCredentialJourney } from './AccountCredentialJourney';

import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';
import { useExactSavedHomeAuthenticationCatalog } from './useExactSavedHomeAuthenticationCatalog';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { HomeContextLine } from '@/components/onboarding/ui/ActiveRelaySummary';

/**
 * Recovery is an exact saved-Home authentication entry, not a second auth
 * workflow. The saved Home's own entry catalog is the authority for every
 * advertised method, whichever Home is currently focused.
 */
type HomeRecoveryAuthenticationFlowProps = Readonly<{
    profileRef: string;
    returnTo: string;
    retryOAuth?: Readonly<{ providerId: string }>;
    onAuthenticated: () => void | Promise<void>;
    onBack: () => void;
}>;

export function HomeRecoveryAuthenticationFlow(props: HomeRecoveryAuthenticationFlowProps): React.ReactElement {
    return <AccountCredentialJourney request={{ kind: 'home', profileRef: props.profileRef, returnTo: props.returnTo }}>
        <HomeRecoveryAuthenticationFlowBody {...props} />
    </AccountCredentialJourney>;
}

function HomeRecoveryAuthenticationFlowBody(props: HomeRecoveryAuthenticationFlowProps): React.ReactElement {
    const profile = getServerProfileById(props.profileRef);
    const catalog = useExactSavedHomeAuthenticationCatalog(profile);
    const homeLabel = profile ? resolveHomeDisplayLabel(profile, profile.id) : null;
    // One signed-out step (lab direction A "Sign in to … again"): the Home it recovers above the heading, then its
    // ways in; a Home that cannot answer says so in the same frame.
    const step = (content: Readonly<{
        testID: string;
        title: string;
        subtitle?: string;
        status?: boolean;
        primary?: React.ComponentProps<typeof AuthRouteStepFrame>['primary'];
        body?: React.ReactNode;
    }>) => (
        <AuthRouteStepFrame
            testID={content.testID}
            title={content.title}
            subtitle={content.subtitle}
            context={homeLabel ? <HomeContextLine testID="home-recovery-home" label={homeLabel} /> : undefined}
            onBack={props.onBack}
            status={content.status}
            primary={content.primary}
        >
            {content.body ?? null}
        </AuthRouteStepFrame>
    );

    const heading = t('server.homes.signInAgainTitle', { name: homeLabel ?? props.profileRef });
    if (!profile || !profile.serverIdentityId?.trim()) {
        return step({
            testID: 'home-recovery-authentication-target-step',
            title: heading,
            body: <SurfaceStateCard
                testID="home-recovery-authentication-target-unavailable"
                size="line"
                lineLayout="notice"
                kind="unavailable"
                title={t(profile ? 'welcome.serverUnavailableTitle' : 'teams.join.unknownHomeTitle')}
                reason={profile
                    ? t('welcome.serverUnavailableBody', { serverUrl: profile.serverUrl })
                    : t('server.notificationAddServerHint')}
                action={{ label: t('common.back'), onPress: props.onBack }}
                actionGlyph="forward"
                accessibilitySemantics="status"
            />,
        });
    }

    if (catalog.state === 'loading') {
        return step({
            testID: 'home-recovery-authentication-loading',
            title: heading,
            body: <SurfaceStateCard testID="home-recovery-authentication-loading-line" size="line" lineLayout="notice"
                kind="loading" title={t('common.loading')} accessibilitySemantics="status" />,
        });
    }

    const loginActions = catalog.actions.filter(({ action }) => action.id === 'login');
    const retry = props.retryOAuth && loginActions.find(({ execution }) => execution.kind === 'oauth'
        && execution.providerId === props.retryOAuth?.providerId);
    const label = homeLabel ?? profile.id;
    if (catalog.state === 'ready' && loginActions.length > 0) {
        return step({
            testID: 'home-recovery-authentication',
            title: t('server.homes.signInAgainTitle', { name: label }),
            subtitle: t('server.homes.signInAgainDescription'),
            body: <HomeAuthenticationFlow
                target={{ kind: 'saved_profile', profileRef: profile.id }}
                actions={retry ? [retry] : loginActions}
                openChosenAction={retry !== undefined}
                transport={catalog.transport ?? undefined}
                keyChallengeV2Available={catalog.keyChallengeV2Available}
                returnTo={props.returnTo}
                homeLabel={label}
                onAuthenticated={() => props.onAuthenticated()}
                onBack={props.onBack}
                showBackAction={false}
                methodsLayout="doorAndWays"
            />,
        });
    }

    return step({
        testID: 'home-recovery-authentication-unavailable-step',
        title: heading,
        // What failed, why, and Try again, as the step's one door-width notice.
        body: <SurfaceStateCard testID="home-recovery-authentication-unavailable" size="line" lineLayout="notice"
            kind="warning"
            title={catalog.state === 'ready'
                ? t('welcome.signInServiceMethodlessTitle')
                : catalog.incompatible
                ? t('welcome.serverIncompatibleTitle')
                : t('welcome.serverUnavailableTitle')}
            reason={catalog.state === 'ready'
                ? label
                : t(catalog.incompatible ? 'welcome.serverIncompatibleBody' : 'welcome.serverUnavailableBody', { serverUrl: label })}
            actionGlyph="retry"
            action={{ label: t('common.retry'), onPress: catalog.retry }}
            accessibilitySemantics="status" />,
    });
}
