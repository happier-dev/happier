import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_WORKSPACE_FILE_VIEWER_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    workspaceFileViewerPreferencesV1: {
        valueKind: 'presence',
        privacy: 'forbidden',
        identityScope: 'person',
    },
});
