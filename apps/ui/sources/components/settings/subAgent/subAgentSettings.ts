import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `subAgent` page. Rows render their labels from these declarations. */
export const SUB_AGENT_SETTINGS = defineSettingsPage({
    pageId: 'subAgent',
    sections: {
        instructions: {
            titleKey: 'subAgentGuidance.settings.instructionsTitle',
            settings: {
                notifyParentOnCompletion: {},
            },
        },
        disabled: {
            titleKey: 'subAgentGuidance.settings.disabled.title',
            settings: {
                enableExecutionRuns: {},
            },
        },
        related: {
            titleKey: 'subAgentGuidance.settings.related.groupTitle',
            settings: {
                session: {},
                agents: {},
            },
        },
    },
});
