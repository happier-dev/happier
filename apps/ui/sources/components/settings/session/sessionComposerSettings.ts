import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of Sessions › Composer (a sub-page linked from Sessions). */
export const SESSION_COMPOSER_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'composer', route: SETTINGS_ROUTES.sessionComposer, titleKey: 'settingsSession.composer.title' },
    sections: {
        newSessions: {
            titleKey: 'settingsSessionPages.composer.newSessionsSection',
            settings: {
                draftEntry: {},
                presentation: {},
            },
        },
        typing: {
            titleKey: 'settingsSessionPages.composer.typingSection',
            settings: {
                enterToSend: {},
                historyScope: { host: settingsHosts.web },
            },
        },
        sending: {
            titleKey: 'settingsSession.messageSending.title',
            settings: {
                sendMode: {},
                busySteer: {},
                nonSteerablePrompt: {},
                inactiveResume: {},
            },
        },
        pendingQueue: {
            titleKey: 'settingsSessionPages.composer.pendingSection',
            settings: {
                pendingDrain: {},
                pendingTiming: {},
            },
        },
        layout: {
            titleKey: 'settingsSessionPages.composer.layoutSection',
            settings: {
                promptLibraryButton: {},
                actionBar: {},
                chipDensity: {},
                glass: {},
            },
        },
        banners: {
            titleKey: 'settingsSession.banners.title',
            settings: {
                rememberBanners: {},
            },
        },
    },
});
