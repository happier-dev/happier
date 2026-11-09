import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable settings of Workflows › Run settings (FIN 04 §3.5, 07 S6): a sub-page the Settings
 * home links to, living under the Workflows destination.
 */
export const WORKFLOW_RUN_SETTINGS = defineSettingsPage({
    pageId: 'settings',
    subpage: { id: 'workflowRuns', route: '/workflows/settings', titleKey: 'workflows.destination.runSettingsPage.title' },
    sections: {
        capacity: {
            titleKey: 'automationPages.settings.capacityTitle',
            featureId: 'workflows',
            settings: {
                maxActiveRunsPerMachine: {},
            },
        },
        history: {
            titleKey: 'automationPages.settings.historyTitle',
            featureId: 'workflows',
            settings: {
                runRetention: {},
            },
        },
    },
});
