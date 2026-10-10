import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `machinesAdd` page. Rows render their labels from these declarations. */
export const MACHINES_ADD_SETTINGS = defineSettingsPage({
    pageId: 'machinesAdd',
    sections: {
        add: {
            titleKey: 'settings.addMachine',
            settings: {
                setupNewMachineAction: {},
            },
        },
    },
});
