import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { externalSessionsAutoLinkSourceStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

/** The searchable settings of the External sessions page (the per-session follow rows are a collection). */
export const EXTERNAL_SESSIONS_SETTINGS = defineSettingsPage({
    pageId: 'externalSessions',
    sections: {
        followPolicy: {
            titleKey: 'externalSessions.settingsFollowGroupTitle',
            settings: {
                keepFollowingAfterRestart: {},
                autoLinkSources: { storage: externalSessionsAutoLinkSourceStorage },
            },
        },
    },
});
