import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `machinesThisComputer` page. Rows render their labels from these declarations. */
export const MACHINES_THIS_COMPUTER_SETTINGS = defineSettingsPage({
    pageId: 'machinesThisComputer',
    sections: {
        setup: {
            titleKey: 'settingsMachines.setupSectionTitle',
            settings: {
                openSetupAction: {},
            },
        },
    },
});
