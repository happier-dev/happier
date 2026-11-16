import * as React from 'react';

import { t } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import { HomeSessionDefaultsSection } from './HomeTeamsPolicySections';

/** The Home's defaults for members' new sessions, opened from the Teams page's one summary row. */
export const HomeAdministrationMemberDefaultsScreen = React.memo(function HomeAdministrationMemberDefaultsScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('teams.settings.memberDefaults.title')}
            description={t('teams.settings.memberDefaults.description')}
        >
            {(context) => <HomeSessionDefaultsSection context={context} />}
        </HomeAdministrationSection>
    );
});
