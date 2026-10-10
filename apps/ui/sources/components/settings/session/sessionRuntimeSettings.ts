import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

import { terminalHostStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

/** The searchable settings of Sessions › Runtime (a sub-page linked from Sessions). */
export const SESSION_RUNTIME_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'runtime', route: SETTINGS_ROUTES.sessionRuntime, titleKey: 'settingsSession.runtime.title' },
    sections: {
        terminal: {
            titleKey: 'settingsSessionPages.runtime.terminalSection',
            settings: {
                host: { storage: terminalHostStorage },
                sessionName: {},
                isolated: {},
                tmpDir: {},
            },
        },
    },
});
