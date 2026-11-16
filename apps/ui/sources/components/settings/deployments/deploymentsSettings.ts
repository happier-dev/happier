import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

export const DEPLOYMENTS_SETTINGS = defineSettingsPage({
    pageId: 'deployments',
    sections: {
        defaults: { titleKey: 'projects.deployments.creationDefaults', settings: { creationDefaults: {} } },
        // Describe your app's model: the background-task runner choice, as commit messages have theirs.
        suggestions: { titleKey: 'projects.deployments.autoSectionTitle', settings: { suggestionAgent: {} } },
    },
});
