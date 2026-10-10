import { defaultEnvironmentShowFirstStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

import { DEFAULT_ENVIRONMENT_ROUTE } from './profileCollectionRoutes';

/**
 * The searchable settings of the Profiles collection. Its only page-level setting is the no-profile
 * choice's place in the pickers; each profile's own fields belong to that profile, not to search.
 * (Turning profiles on and off is searchable on Features, the switch's one declared row.)
 */
export const PROFILES_SETTINGS = defineSettingsPage({
    pageId: 'profiles',
    subpage: { id: 'defaultEnvironment', route: DEFAULT_ENVIRONMENT_ROUTE, titleKey: 'profiles.noProfile' },
    sections: {
        picker: {
            titleKey: 'profilesPage.pickerSection',
            settings: {
                showFirst: {
                    storage: defaultEnvironmentShowFirstStorage,

                },
            },
        },
    },
});
