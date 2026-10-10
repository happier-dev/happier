import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import { TeamLinkDelivery } from '../TeamLinkDelivery';

/**
 * Where an administrator gets the page they send members to.
 *
 * The link itself is the Home's, not this screen's: only the Home knows the
 * application origin it is served at and the portable carrier that makes the
 * link work on a phone which has never seen this Home. Composing one here from
 * the app's own origin would produce a link that silently works for the person
 * who copied it and fails for everyone else, so a Home that publishes neither
 * gets an explanation instead of a control.
 *
 * Open is deliberately an in-app preview of the exact Team's sign-in route
 * rather than a browser trip to the copied text: the administrator wants to see
 * what a member sees, and the app can already render that page.
 */
export const TeamMemberSignInLinkSection = React.memo(function TeamMemberSignInLinkSection(props: Readonly<{
    address: TeamAddress;
    memberSignInUrl: string | null;
}>) {
    const router = useRouter();
    const preview = React.useCallback(() => {
        if (props.memberSignInUrl === null) return;
        // The Home already built and validated this public URL. Route its path
        // inside the app, but retain the exact portable target query rather
        // than replacing it with this device's local profile id.
        const url = new URL(props.memberSignInUrl);
        router.push(`${url.pathname}${url.search}`);
    }, [props.memberSignInUrl, router]);

    if (props.memberSignInUrl === null) {
        return (
            <ItemGroup
                title={t('teams.authentication.memberSignIn.section')}
                description={t('teams.authentication.memberSignIn.unavailableBody')}
            >
                <Item
                    testID="team-member-sign-in-unavailable"
                    title={t('teams.authentication.memberSignIn.unavailable')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    return (
        <TeamLinkDelivery
            url={props.memberSignInUrl}
            testIDPrefix="team-member-sign-in"
            title={t('teams.authentication.memberSignIn.section')}
            copyLabel={t('teams.authentication.memberSignIn.copyLink')}
            shareLabel={t('teams.authentication.memberSignIn.shareLink')}
            qrActionLabel={t('teams.authentication.memberSignIn.qrLabel')}
            qrAccessibilityLabel={t('teams.authentication.memberSignIn.qrLabel')}
            description={t('teams.authentication.memberSignIn.footer')}
            open={{ label: t('teams.authentication.memberSignIn.open'), onPress: preview }}
        />
    );
});
