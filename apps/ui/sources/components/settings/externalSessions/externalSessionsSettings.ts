import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the External sessions page (the per-session follow rows are a collection). */
export const EXTERNAL_SESSIONS_SETTINGS = defineSettingsPage({
    pageId: 'externalSessions',
    sections: {
        followPolicy: {
            titleKey: 'externalSessions.settingsFollowGroupTitle',
            settings: {
                keepFollowingAfterRestart: {},
            },
        },
    },
});
