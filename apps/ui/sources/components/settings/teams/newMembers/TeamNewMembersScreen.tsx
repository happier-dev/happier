import * as React from 'react';

import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import { TeamMemberDefaultsSection } from '../defaults/TeamMemberDefaultsSection';
import { memberDefaultsAccess } from '../defaults/memberDefaults';
import { TeamNewMembersSources } from './TeamNewMembersSources';

const TEAM_DEFAULTS_SCOPE = Object.freeze({ kind: 'team' as const });

/**
 * What new members get (plan D, L5): one page that composes what an administrator chooses for
 * people who join. It embeds the shipped member-defaults editor whole, with its per-pick commit;
 * Team Settings links here through its summary row rather than keeping a second editor.
 */
export const TeamNewMembersScreen = React.memo(function TeamNewMembersScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.newMembers.title')}
            description={t('teams.newMembers.description')}
        >
            {(context) => context.archived ? null : (
                <>
                    <TeamMemberDefaultsSection
                        testID="team-new-members-defaults"
                        context={context}
                        scope={TEAM_DEFAULTS_SCOPE}
                        access={memberDefaultsAccess(TEAM_DEFAULTS_SCOPE, context.team.capabilities)}
                        writable={context.canMutate}
                    />
                    <TeamNewMembersSources context={context} />
                </>
            )}
        </TeamSection>
    );
});
