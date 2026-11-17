import * as React from 'react';
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

const TEAM_HEADER_AVATAR_SIZE = 44;

/**
 * The Team's lockup at the head of a Team page (overview, setup). The avatar owner derives the
 * monogram and accent from the immutable Team id, never from the name: two Teams may share a name.
 */
export const TeamHeaderAvatar = React.memo(function TeamHeaderAvatar(props: Readonly<{
    address: TeamAddress;
    team: Pick<TeamSummaryV1, 'name' | 'logo'>;
}>) {
    return (
        <Avatar
            id={props.address.teamId}
            monogram={props.team.name}
            square
            size={TEAM_HEADER_AVATAR_SIZE}
            imageUrl={props.team.logo?.url ?? null}
            thumbhash={props.team.logo?.thumbhash ?? null}
        />
    );
});
