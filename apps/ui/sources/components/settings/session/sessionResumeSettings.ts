import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of Sessions › Resume (a sub-page linked from Sessions). */
export const SESSION_RESUME_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'resume', route: SETTINGS_ROUTES.sessionResume, titleKey: 'settingsSession.resume.title' },
    sections: {
        replay: {
            titleKey: 'settingsSession.replayResume.title',
            settings: {
                replayEnabled: {},
                replayStrategy: {},
                maxSeedChars: {},
                summaryModel: {},
            },
        },
        handoff: {
            titleKey: 'settingsSessionPages.resume.handoffSection',
            settings: {
                handoff: {},
            },
        },
    },
});
