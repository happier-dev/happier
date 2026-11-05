import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { desktopLoginStartBinding } from './desktopLoginStart';


/**
 * The searchable settings of the `desktop` page. Rows render their labels from these declarations.
 * Everything here exists only in the desktop app; the overlay rows below `enabled` also wait on it.
 */
export const DESKTOP_SETTINGS = defineSettingsPage({
    pageId: 'desktop',
    sections: {
        startup: {
            titleKey: 'settingsDesktop.startupTitle',
            host: settingsHosts.desktop,
            settings: {
                startOnLogin: { storage: desktopLoginStartBinding },
            },
        },
        overlay: {
            titleKey: 'settingsDesktop.overlay.title',
            host: settingsHosts.desktop,
            settings: {
                enabled: {},
                dock: {},
                display: {},
                idle: {},
                visibilityMode: {},
                botConversationPresentation: {},
                alwaysOnTop: {},
            },
        },

    },
});
