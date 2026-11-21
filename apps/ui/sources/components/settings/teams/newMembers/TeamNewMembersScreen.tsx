import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamSetupPath } from '../teamsRoutes';
import { TeamMemberDefaultsSection } from '../defaults/TeamMemberDefaultsSection';
import { memberDefaultsAccess } from '../defaults/memberDefaults';
import { TeamNewMembersKeys } from './TeamNewMembersKeys';
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
            renderHeaderActions={(context) => context.archived ? null : <PreviewAsMemberAction context={context} />}
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
                    <TeamNewMembersSources
                        context={context}
                        renderKeys={(sources) => <TeamNewMembersKeys context={context} sources={sources} />}
                    />
                </>
            )}
        </TeamSection>
    );
});

/** Opens the member's own setup page in preview: the same reads a member makes, with nothing to run. */
const PreviewAsMemberAction = React.memo(function PreviewAsMemberAction(props: Readonly<{ context: TeamSectionContext }>) {
    const router = useRouter();
    return (
        <SectionActionButton
            testID="team-new-members-preview"
            icon="eye"
            title={t('teams.newMembers.preview')}
            onPress={() => router.push(teamSetupPath(props.context.address, { preview: true }) as never)}
        />
    );
});
