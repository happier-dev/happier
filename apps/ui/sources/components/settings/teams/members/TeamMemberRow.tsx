import * as React from 'react';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import type { TeamMembershipV1 } from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';

import type { TeamSectionContext } from '../teamSectionContext';
import { TeamLeaveAction } from './TeamLeaveAction';
import { teamMemberRowSubtitle } from './teamMemberPresentation';


/** One person on a Team: the Members roster and the People page draw the same row. */
export const TeamMemberRow = React.memo(function TeamMemberRow(props: Readonly<{
    membership: TeamMembershipV1;
    viewerAccountId: string;
    language: string;
    leaveContext?: TeamSectionContext;
    onOpen: (membershipId: string) => void;
}>) {
    const { membership, leaveContext } = props;
    const person = resolveAccountDisplayName({ profile: membership.account, accountId: membership.accountId, viewerAccountId: props.viewerAccountId });
    return (
        <Item
            testID={`team-members-row:${membership.id}`}
            title={person.name}
            subtitle={teamMemberRowSubtitle(membership, person, t('teams.members.joined', {
                when: formatCalendarDate(membership.joinedAt, props.language),
            }))}
            leftElement={<Avatar id={membership.accountId} size={PAGE_LIST_METRICS.rowIdentityMarkPx} imageUrl={membership.account.avatarUrl} monogram={person.named ? person.name : null} />}
            accessoryLayout="adaptive"
            rightElementOutsidePressable={leaveContext !== undefined}
            rightElement={membership.status === 'suspended' || leaveContext ? <>
                {membership.status === 'suspended' ? <StatusPill
                    testID={`team-members-status:${membership.id}`}
                    variant="warning"
                    label={t('teams.status.suspended')}
                    labelVariant="phrase"
                /> : null}
                {leaveContext ? <TeamLeaveAction context={leaveContext} presentation="button" testID={`team-members-leave:${membership.id}`} /> : null}
            </> : undefined}
            onPress={() => props.onOpen(membership.id)}
        />
    );
});
