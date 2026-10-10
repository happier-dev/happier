import { buildSettingHref, defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationTeamsPath } from './homeAdministrationRoutes';

/** Who creates Teams on a Home, and whether members outside every Team see them: the Teams page's (DR-09). */
export const HOME_TEAMS_POLICY_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'teamsPolicy',
        titleKey: 'homeGovernance.teams',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationTeamsPath(serverId) : null;
        },
    },
    sections: {
        teamCreation: { titleKey: 'homeGovernance.teamCreation', settings: {
            teamCreationPolicy: {},
        } },
        teamsVisibility: { titleKey: 'homeGovernance.teamsVisibility', settings: {
            teamsVisibleToMembers: {},
        } },
    },
});

/** Where "who can create Teams" is changed: the console's Teams page, at that control. */
export function homeTeamCreationPolicyHref(serverId: string): string {
    return buildSettingHref(homeAdministrationTeamsPath(serverId), HOME_TEAMS_POLICY_SETTINGS.settings.teamCreationPolicy);
}
