import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable settings of Workflows › Run settings (FIN 04 §3.5, 07 S6): a sub-page the Settings
 * home links to, living under the Workflows destination. Offered while Automations is on.
 */
export const WORKFLOW_RUN_SETTINGS = defineSettingsPage({
    pageId: 'settings',
    subpage: { id: 'workflowRuns', route: '/workflows/settings', titleKey: 'workflows.destination.runSettingsPage.title' },
    sections: {
        capacity: {
            titleKey: 'automationPages.settings.capacityTitle',
            featureId: 'automations',
            settings: {
                maxActiveRunsPerMachine: {
                    titleKey: 'automations.settings.maxActiveRunsPerMachine',
                    descriptionKey: 'automations.settings.maxActiveRunsPerMachineSubtitle',
                    storage: { scope: 'account', kind: 'automationSettings', field: 'maxActiveRunsPerMachine', access: 'read_write' },
                },
            },
        },
        history: {
            titleKey: 'automationPages.settings.historyTitle',
            featureId: 'automations',
            settings: {
                runRetention: {
                    titleKey: 'automations.settings.runRetention',
                    descriptionKey: 'automations.settings.runRetentionSubtitle',
                    storage: { scope: 'account', kind: 'automationSettings', field: 'runRetention', access: 'read_write' },
                },
            },
        },
    },
});
