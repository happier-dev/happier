import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';

import { useStoredAccountServiceSignIn } from '@/components/account/auth/useAccountServiceSignedInName';
import { useHomeAccountServiceEntry } from '@/components/account/auth/useHomeAccountServiceEntry';
import {
    describeAccountServiceIdentity,
    resolveAccountServiceIdentity,
} from '@/components/navigation/accountPopover/accountPopoverModel';
import { resolveHomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { useActiveHomeConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { homeRoleLabel } from '@/components/settings/home/governance/homeGovernanceLabels';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { useHomeViewerRole } from '@/hooks/home/useHomeViewerRole';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { formatAccountDisplayName, resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { getActiveServerHomeCarrier, getServerProfileById, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * Where the person stands with the account service this Home points at, as the account popover's
 * identity row says it (same entry owner, reachability verdict, stored sign-in and wording). `null`
 * while it is not known yet, so the line never flashes a wrong state; a Home that does not answer
 * settles to "Sign-in status unavailable". The stored sign-in is re-read on focus.
 */
function useHomeAccountServiceLine(profile: ServerProfile | null): string | null {
    const snapshot = useActiveServerSnapshot();
    const healthKind = useActiveHomeConnectionHealth().kind;
    const homeUnreachable = resolveHomeConnectionSummary({ healthKind }).kind === 'unavailable';
    const homeCarrier = getActiveServerHomeCarrier();
    const { entry, namedService, policyReady, policyFailed } = useHomeAccountServiceEntry({
        profile,
        runtimeOrigin: homeCarrier ? null : snapshot.runtimeOrigin ?? null,
        homeCarrier,
    });
    const [rereadKey, reread] = React.useReducer((value: number) => value + 1, 0);
    // The first focus coincides with mount, whose read the sign-in owner already makes.
    const focusedOnceRef = React.useRef(false);
    useFocusEffect(React.useCallback(() => {
        if (focusedOnceRef.current) reread();
        focusedOnceRef.current = true;
    }, []));
    const discovery = entry.status === 'ready' ? entry.discovery : null;
    const stored = useStoredAccountServiceSignIn({
        url: discovery?.endpointUrl ?? entry.endpoint.url,
        serverIdentityId: discovery?.serverIdentityId ?? entry.endpoint.serverIdentityId ?? null,
    }, rereadKey);
    const identity = resolveAccountServiceIdentity({
        entryStatus: entry.status,
        signedIn: stored.signedIn === true,
        serviceName: namedService,
        selfService: entry.effectiveSignInService.kind === 'self',
        policyReady,
        // The reachability owner's verdict on this Home, read as the popover reads it (its summary).
        policyUnavailable: policyFailed || homeUnreachable,
    });
    if (identity.kind === 'pending' || identity.kind === 'loading') return null;
    if ((identity.kind === 'signed_in' || identity.kind === 'not_linked') && stored.signedIn === null) return null;
    return describeAccountServiceIdentity(identity, 'sentence');
}

/**
 * Who is here: the person (their name, else "Your account") with their avatar, then the Home they
 * are in, their role there and where they stand with its account service, with the way to their
 * Account. Name, avatar and the account-service line come from the owners the account popover uses,
 * so the two surfaces agree. The role appears once the Home's governance answers, so the header
 * never waits (an unreachable Home simply shows no role).
 */
export const HubIdentityHeader = React.memo(function HubIdentityHeader() {
    const router = useRouter();
    const profile = useProfile();
    const displayName = resolveViewerAccountDisplayName(formatAccountDisplayName(profile));
    const activeServer = useActiveServerSnapshot();
    useServerProfilesGeneration();
    const homeProfile = getServerProfileById(activeServer.serverId);
    // Which Home: its name, else "Home on <host>" — this header exists to tell the person where they are.
    const homeName = resolveHomeDisplayLabel(homeProfile, '');
    const role = useHomeViewerRole(activeServer.serverId);
    const accountServiceLine = useHomeAccountServiceLine(homeProfile);
    const meta: PageHeaderMetaFact[] = [
        ...(homeName ? [{ key: 'home', text: homeName, icon: 'house' as const, testID: 'settings-overview-home' }] : []),
        ...(role ? [{ key: 'role', text: homeRoleLabel(role), testID: 'settings-overview-role' }] : []),
        ...(accountServiceLine
            ? [{ key: 'accountService', text: accountServiceLine, testID: 'settings-overview-account-service' }]
            : []),
    ];

    return (
        <SettingsPageHeader
            testID="settings-overview-identity"
            title={displayName}
            alwaysShowTitle
            meta={meta.length > 0 ? meta : undefined}
            leading={(
                <Avatar
                    id={profile.id}
                    size={48}
                    imageUrl={getAvatarUrl(profile)}
                    thumbhash={profile.avatar?.thumbhash}
                />
            )}
            actions={(
                <RoundButton
                    testID="settings-overview-account"
                    display="secondary"
                    title={t('settings.account')}
                    onPress={() => router.push(SETTINGS_ROUTES.account as never)}
                />
            )}
        />
    );
});
