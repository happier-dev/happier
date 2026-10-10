import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

import { presentationStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

const PRESENTATION_KEYWORDS = [
    'settingsSession.sessionCreation.wizardPresentationAutoTitle',
    'settingsSession.sessionCreation.wizardPresentationListTitle',
    'settingsSession.sessionCreation.wizardPresentationDropdownTitle',
] as const;

/** The searchable settings of Sessions › Wizard layout (a sub-page linked from Sessions). */
export const NEW_SESSION_WIZARD_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'wizard', route: SETTINGS_ROUTES.newSessionWizard, titleKey: 'settingsSession.sessionCreation.wizardDispositionTitle' },
    sections: {
        wideScreens: {
            titleKey: 'settingsSessionPages.wizard.wideScreensSection',
            settings: {
                columns: {},
            },
        },
        steps: {
            titleKey: 'settingsSessionPages.wizard.stepsSection',
            settings: {
                profiles: { storage: presentationStorage('profiles') },
                backends: { storage: presentationStorage('backends') },
                models: { storage: presentationStorage('models') },
                machines: { storage: presentationStorage('machines') },
                paths: { storage: presentationStorage('paths') },
                permissions: { storage: presentationStorage('permissions') },
            },
        },
    },
});
