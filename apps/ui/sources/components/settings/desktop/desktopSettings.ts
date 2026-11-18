import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { desktopLoginStartBinding } from './desktopLoginStart';
import { desktopWindowChromeBinding } from './desktopWindowChromeBinding';
import { desktopCapturePreferenceBinding } from './desktopCapturePreferenceBinding';


/**
 * The searchable settings of the `desktop` page. Rows render their labels from these declarations.
 * Everything here exists only in the desktop app; the overlay rows below `enabled` also wait on it.
 */
export const DESKTOP_SETTINGS = defineSettingsPage({
    pageId: 'desktop',
    sections: {
        screenCapture: {
            titleKey: 'screenCapture.settings.title',
            host: settingsHosts.tauriDesktop,
            settings: {
                captureShortcut: { storage: desktopCapturePreferenceBinding('captureShortcut') },
                instantWindowShortcut: { storage: desktopCapturePreferenceBinding('instantWindowShortcut') },
                recordingShortcut: { storage: desktopCapturePreferenceBinding('recordingShortcut') },
                captureSound: {},
                captureIncludeWindowText: {},
                captureIncludeWindowShadow: { storage: desktopCapturePreferenceBinding('includeWindowShadow') },
                captureFolder: { storage: desktopCapturePreferenceBinding('libraryFolder') },
            },
        },
        window: {
            host: settingsHosts.desktop,
            settings: { nativeTitleBar: { storage: desktopWindowChromeBinding } },
        },
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
                notchConversationPresentation: {},
                alwaysOnTop: {},
            },
        },
        windows: {
            titleKey: 'settingsDesktop.windows.title',
            host: settingsHosts.desktop,
            settings: { windowBotRail: {} },
        },

    },
});
