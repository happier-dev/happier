import * as React from 'react';

import { TeamSectionPageHeader } from '@/components/settings/teams/TeamSection';
import { TeamMembersView } from '@/components/settings/teams/members/TeamMembersScreen';
import { getDemoModeServerId } from '@/demoMode/runtime/enterExitDemoMode';
import { buildDemoTeam } from '@/demoMode/world/team';
import { t } from '@/text';

function noop(): void {}

/** The complete production Members view and Team shell header, with local display-only reads. */
export function TeamStageSurface(): React.ReactElement {
    const [data] = React.useState(() => buildDemoTeam(getDemoModeServerId() ?? 'demo-home'));
    return <TeamMembersView context={data.context} roster={data.roster}
        filter="all" setFilter={noop} query="" setQuery={noop}
        header={<TeamSectionPageHeader title={t('teams.tabs.members')} description={t('teams.pages.members')}
            alwaysShowTitle={false} teamName={data.context.team.name} homeName={data.context.homeName} />} />;
}
