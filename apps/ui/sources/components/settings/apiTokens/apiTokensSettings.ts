import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** API Tokens' searchable settings (plan 01 §6.1). Rows render their labels from these declarations. */
export const API_TOKEN_SETTINGS = defineSettingsPage({
    pageId: 'apiTokens',
    sections: {
        cliApprovals: {
            titleKey: 'settingsApiTokens.cliPolicy.sectionTitle',
            settings: {
                cliApprovals: {},
            },
        },
        security: {
            titleKey: 'settingsApiTokens.securityTitle',
            settings: {
                revokeAll: {},
            },
        },
    },
});
