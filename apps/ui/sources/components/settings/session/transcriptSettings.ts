import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { thinkingDisplayStorageBinding } from '@/components/settings/session/thinkingDisplayChoice';

/** The searchable settings of the `transcript` page. Rows render their labels from these declarations. */
export const TRANSCRIPT_SETTINGS = defineSettingsPage({
    pageId: 'transcript',
    sections: {
        layout: {
            titleKey: 'settingsSession.transcript.layoutTitle',
            settings: {
                layoutPicker: {},
                messageTimestamps: {},
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
