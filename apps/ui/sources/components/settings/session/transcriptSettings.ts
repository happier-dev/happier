import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { thinkingDisplayStorageBinding } from '@/components/settings/session/thinkingDisplayChoice';
import { ACCOUNT_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';

/** The searchable settings of the `transcript` page. Rows render their labels from these declarations. */
export const TRANSCRIPT_SETTINGS = defineSettingsPage({
    pageId: 'transcript',
    sections: {
        layout: {
            titleKey: 'settingsSession.transcript.layoutTitle',
            settings: {
                layoutPicker: {},
                messageTimestamps: {},
                showTurnDuration: {},
                linkAgentNames: {},
                chatLinkOpenLocation: {},
            },
        },
        thinking: {
            titleKey: 'settingsSession.thinking.title',
            settings: {
                displayMode: {

                    storage: thinkingDisplayStorageBinding,

                },
                inlineChrome: {},
            },
        },
        toolRendering: {
            titleKey: 'settingsSessionPages.transcript.toolsSection',
            settings: {
                showToolCalls: {},
                timelineChrome: {},
                toolCallsGroup: {},
                toolCallsStrategy: {},
                toolCallsCollapsedPreviewCount: {},
                toolCallsGroupBackground: {},
                defaultToolDetailLevel: {},
                expandedToolDetailLevel: {},
                cardTapAction: {},
                defaultExpanded: {},
                showDebugByDefault: {},
                toolDetailOverrides: {},
            },
        },
        agentVisuals: {
            titleKey: 'settingsSessionPages.transcript.agentVisualsSection',
            settings: {
                agentHtmlNetworkPolicy: ACCOUNT_SETTING_DECLARATIONS_V1.agentHtmlNetworkPolicy,
            },
        },
        group: {
            titleKey: 'settingsSession.transcript.messageActions.groupTitle',
            settings: {
                copyEnabled: {},
                forkEnabled: {},
                rollbackEnabled: {},
                pinEnabled: {},
                savePromptEnabled: {},
                makeRepeatableEnabled: {},
                pluginsEnabled: {},
                selectionEnabled: {},
            },
        },
        selection: {
            titleKey: 'settingsSession.transcript.messageActions.selectionTitle',
            settings: {
                sendToSessionEnabled: {},
                sendToSessionTemplate: {},
                bulkCopyFormat: {},
            },
        },
        motion: {
            titleKey: 'settingsSession.transcript.motionTitle',
            settings: {
                motionPicker: {},
            },
        },
        scroll: {
            titleKey: 'settingsSession.transcript.scrollTitle',
            settings: {
                scrollPin: {},
                jumpToBottom: {},
            },
        },
        advanced: {
            titleKey: 'settingsSession.advanced.title',
            settings: {
                advanced: {},
            },
        },
    },
});
