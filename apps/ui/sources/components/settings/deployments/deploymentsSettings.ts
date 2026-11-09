import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

export const DEPLOYMENTS_SETTINGS = defineSettingsPage({
    pageId: 'deployments',
    sections: { defaults: { titleKey: 'projects.deployments.creationDefaults', settings: { creationDefaults: {} } } },
});
