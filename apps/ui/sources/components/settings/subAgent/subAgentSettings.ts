import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { DELEGATION_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';

/**
 * The searchable settings of the `subAgent` page. Rows render their labels from these declarations.
 * Work depth and Approval reviewer keep their `delegation.*` anchors (Actions, docs and saved links
 * name them); only their page moved here when Delegation merged into Subagents.
 */
export const SUB_AGENT_SETTINGS = defineSettingsPage({
    pageId: 'subAgent',
    sections: {
        workDepth: {
            titleKey: 'roles.delegation.depthTitle',
            settings: {
                workDepthLimit: DELEGATION_SETTING_DECLARATIONS_V1.workDepthLimit,
            },
        },
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
        approvalReviewer: {
            titleKey: 'roles.delegation.approvalReviewer',
            settings: {
                approvalReviewerEnabled: DELEGATION_SETTING_DECLARATIONS_V1.approvalReviewerEnabled,
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
