import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { DELEGATION_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol';

/** The searchable settings of the `delegation` page. Rows render their labels from these declarations. */
export const DELEGATION_SETTINGS = defineSettingsPage({
    pageId: 'delegation',
    sections: {
        approvalReviewer: {
            titleKey: 'roles.delegation.approvalReviewer',
            settings: {
                approvalReviewerEnabled: DELEGATION_SETTING_DECLARATIONS_V1.approvalReviewerEnabled,
            },
        },
        workDepth: {
            titleKey: 'roles.delegation.depthTitle',
            settings: {
                workDepthLimit: DELEGATION_SETTING_DECLARATIONS_V1.workDepthLimit,
            },
        },
    },
});
