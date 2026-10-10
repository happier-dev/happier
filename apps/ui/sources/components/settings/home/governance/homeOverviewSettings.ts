import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationOverviewPath } from './homeAdministrationRoutes';
import { homeRegistrySettingDeclaration } from './homeServerSettings';

/** The Home's own name: edited on Overview, where it heads the console (DR-08). */
export const HOME_NAME_SETTING_KEY = SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key;

// The key is in the static registry, so its declaration always builds.
const homeNameDeclaration = homeRegistrySettingDeclaration(HOME_NAME_SETTING_KEY)!.declaration;

/** What Overview renders as a setting, found by its name in search. */
export const HOME_OVERVIEW_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'overview',
        titleKey: 'homeGovernance.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationOverviewPath(serverId) : null;
        },
    },
    sections: {
        thisHome: { titleKey: 'homeGovernance.overviewPage.thisHome', settings: {
            homeName: homeNameDeclaration,
        } },
    },
});
