import * as React from 'react';
import { AccountCredentialJourney } from './AccountCredentialJourney';

import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';
import { useExactSavedHomeAuthenticationCatalog } from './useExactSavedHomeAuthenticationCatalog';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

/**
 * Recovery is an exact saved-Home authentication entry, not a second auth
 * workflow. The saved Home's own entry catalog is the authority for every
 * advertised method, whichever Home is currently focused.
 */
type HomeRecoveryAuthenticationFlowProps = Readonly<{
    profileRef: string;
    returnTo: string;
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

    if (!profile || !profile.serverIdentityId?.trim()) {
        return <SurfaceStateCard
            testID="home-recovery-authentication-target-unavailable"
            kind="unavailable"
            title={t('welcome.serverUnavailableTitle')}
            reason={profile
                ? t('welcome.serverUnavailableBody', { serverUrl: profile.serverUrl })
                : t('errors.operationFailed')}
            action={{ label: t('common.back'), onPress: props.onBack }}
            accessibilitySemantics="status"
        />;
    }

    if (catalog.state === 'loading') {
        return <SurfaceStateCard
            testID="home-recovery-authentication-loading"
            kind="loading"
            title={t('common.loading')}
            accessibilitySemantics="status"
        />;
    }

    if (catalog.state === 'ready' && catalog.actions.length > 0) {
        return <HomeAuthenticationFlow
            target={{ kind: 'saved_profile', profileRef: profile.id }}
            actions={catalog.actions}
            transport={catalog.transport ?? undefined}
            keyChallengeV2Available={catalog.keyChallengeV2Available}
            returnTo={props.returnTo}
            homeLabel={resolveHomeDisplayLabel(profile, profile.id)}
            onAuthenticated={() => props.onAuthenticated()}
            onBack={props.onBack}
        />;
    }

    return <SurfaceStateCard
        testID="home-recovery-authentication-unavailable"
        kind="unavailable"
        title={catalog.incompatible
            ? t('welcome.serverIncompatibleTitle')
            : t('welcome.serverUnavailableTitle')}
        reason={t('errors.operationFailed')}
        action={{ label: t('common.retry'), onPress: catalog.retry }}
        secondaryAction={{ label: t('common.back'), onPress: props.onBack }}
        accessibilitySemantics="status"
    />;
}
