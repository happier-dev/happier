import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { thinkingDisplayStorageBinding } from '@/components/settings/session/thinkingDisplayChoice';

/** The searchable settings of the `transcript` page. Rows render their labels from these declarations. */
export const TRANSCRIPT_SETTINGS = defineSettingsPage({
    pageId: 'transcript',
    sections: {
        layout: {
            titleKey: 'settingsSession.transcript.layoutTitle',
            settings: {
                layoutPicker: { storage: { scope: 'account', key: 'transcriptGroupingMode', access: 'read_write' },
                    titleKey: 'settingsSession.transcript.layoutPickerTitle',
                    keywordKeys: ['settingsSession.transcript.layout.linearTitle', 'settingsSession.transcript.layout.turnsTitle'],
                },
                messageTimestamps: { storage: { scope: 'account', key: 'transcriptMessageTimestampDisplayMode', access: 'read_write' }, titleKey: 'settingsSession.transcript.messageTimestampsTitle' },
            },
        },
        thinking: {
            titleKey: 'settingsSession.thinking.title',
            settings: {
                displayMode: {
                    titleKey: 'settingsSession.thinking.displayModeTitle',
                    storage: thinkingDisplayStorageBinding,
                    keywordKeys: ['settingsSessionPages.transcript.thinkingSummary', 'settingsSession.thinking.displayMode.toolTitle'],
                },
                inlineChrome: { storage: { scope: 'account', key: 'sessionThinkingInlineChrome', access: 'read_write' }, titleKey: 'settingsSession.thinking.inlineChromeTitle', descriptionKey: 'settingsSession.thinking.inlineChromeSubtitle' },
            },
        },
        toolRendering: {
            titleKey: 'settingsSessionPages.transcript.toolsSection',
            settings: {
                timelineChrome: { storage: { scope: 'account', key: 'toolViewTimelineChromeMode', access: 'read_write' },
                    titleKey: 'settingsSession.toolRendering.timelineChrome.title',
                    keywordKeys: ['settingsSession.toolRendering.timelineChrome.cardsTitle', 'settingsSession.toolRendering.timelineChrome.activityFeedTitle'],
                },
                toolCallsGroup: { storage: { scope: 'account', key: 'transcriptGroupToolCalls', access: 'read_write' }, titleKey: 'settingsSession.transcript.toolCallsGroupTitle', descriptionKey: 'settingsSession.transcript.toolCallsGroupSubtitle' },
                toolCallsStrategy: { storage: { scope: 'account', key: 'transcriptTurnToolCallsGroupStrategy', access: 'read_write' }, titleKey: 'settingsSession.transcript.advanced.toolCallsStrategyTitle' },
                toolCallsCollapsedPreviewCount: { storage: { scope: 'account', key: 'transcriptToolCallsCollapsedPreviewCount', access: 'read_write' }, titleKey: 'settingsSession.transcript.advanced.toolCallsCollapsedPreviewCountTitle' },
                toolCallsGroupBackground: { storage: { scope: 'account', key: 'transcriptToolCallsGroupShowBackground', access: 'read_write' }, titleKey: 'settingsSession.transcript.toolCallsGroupBackgroundTitle', descriptionKey: 'settingsSession.transcript.toolCallsGroupBackgroundSubtitle' },
                defaultToolDetailLevel: { storage: { scope: 'account', key: 'toolViewDetailLevelDefault', access: 'read_write' }, titleKey: 'settingsSession.toolRendering.defaultToolDetailLevelTitle' },
                expandedToolDetailLevel: { storage: { scope: 'account', key: 'toolViewExpandedDetailLevelDefault', access: 'read_write' }, titleKey: 'settingsSession.toolRendering.expandedToolDetailLevelTitle' },
                cardTapAction: { storage: { scope: 'account', key: 'toolViewTapAction', access: 'read_write' }, titleKey: 'settingsSession.toolRendering.cardTapActionTitle' },
                defaultExpanded: { storage: { scope: 'account', key: 'toolViewTimelineFeedDefaultExpanded', access: 'read_write' }, titleKey: 'settingsSession.toolRendering.activityFeed.defaultExpandedTitle', descriptionKey: 'settingsSession.toolRendering.activityFeed.defaultExpandedSubtitle' },
                showDebugByDefault: { storage: { scope: 'account', key: 'toolViewShowDebugByDefault', access: 'read_write' }, titleKey: 'settingsSession.toolRendering.showDebugByDefaultTitle', descriptionKey: 'settingsSession.toolRendering.showDebugByDefaultSubtitle' },
                toolDetailOverrides: { titleKey: 'settingsSession.toolDetailOverrides.title', descriptionKey: 'settingsSessionPages.transcript.toolOverridesDescription' },
            },
        },
        group: {
            titleKey: 'settingsSession.transcript.messageActions.groupTitle',
            settings: {
                copyEnabled: { storage: { scope: 'account', key: 'transcriptMessageCopyActionEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.copy', descriptionKey: 'committedMessageActions.copyHint' },
                forkEnabled: { storage: { scope: 'account', key: 'transcriptMessageForkActionEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.fork', descriptionKey: 'committedMessageActions.forkHint' },
                rollbackEnabled: { storage: { scope: 'account', key: 'transcriptMessageRollbackActionEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.rollback', descriptionKey: 'committedMessageActions.rollbackHint' },
                pinEnabled: { storage: { scope: 'account', key: 'transcriptMessagePinActionEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.pin', descriptionKey: 'committedMessageActions.pinHint' },
                savePromptEnabled: { storage: { scope: 'account', key: 'transcriptMessageSavePromptActionEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.savePrompt', descriptionKey: 'committedMessageActions.savePromptSettingHint' },
                makeRepeatableEnabled: { storage: { scope: 'account', key: 'transcriptMessageMakeRepeatableActionEnabled', access: 'read_write' }, titleKey: 'workflows.authoring.repeatable', descriptionKey: 'workflows.authoring.repeatableDescription' },
                pluginsEnabled: { storage: { scope: 'account', key: 'transcriptMessagePluginActionsEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.plugins', descriptionKey: 'committedMessageActions.pluginsHint' },
                selectionEnabled: { storage: { scope: 'account', key: 'transcriptMessageSelectionEnabled', access: 'read_write' }, titleKey: 'settingsSession.transcript.messageActions.selectionEnabled.title', descriptionKey: 'settingsSession.transcript.messageActions.selectionEnabled.subtitle' },
                sendToSessionEnabled: { storage: { scope: 'account', key: 'transcriptMessageSendToSessionEnabled', access: 'read_write' }, titleKey: 'settingsSession.transcript.messageActions.sendToSessionEnabled.title', descriptionKey: 'settingsSession.transcript.messageActions.sendToSessionEnabled.subtitle' },
                sendToSessionTemplate: { storage: { scope: 'account', key: 'transcriptMessageSendToSessionTemplate', access: 'read_write' }, titleKey: 'settingsSession.transcript.messageActions.template.title' },
                bulkCopyFormat: { storage: { scope: 'account', key: 'transcriptBulkCopyFormat', access: 'read_write' },
                    titleKey: 'settingsSession.transcript.messageActions.bulkCopyFormat.title',
                    keywordKeys: ['settingsSessionPages.transcript.copyMarkdown', 'settingsSession.transcript.messageActions.bulkCopyFormat.plain'],
                },
            },
        },
        motion: {
            titleKey: 'settingsSession.transcript.motionTitle',
            settings: {
                motionPicker: { storage: { scope: 'account', key: 'transcriptMotionPreset', access: 'read_write' }, titleKey: 'settingsSession.transcript.motionPickerTitle' },
            },
        },
        scroll: {
            titleKey: 'settingsSession.transcript.scrollTitle',
            settings: {
                scrollPin: { storage: { scope: 'account', key: 'transcriptScrollPinEnabled', access: 'read_write' }, titleKey: 'settingsSession.transcript.scrollPinTitle', descriptionKey: 'settingsSession.transcript.scrollPinSubtitle' },
                jumpToBottom: { storage: { scope: 'account', key: 'transcriptScrollJumpToBottomEnabled', access: 'read_write' }, titleKey: 'settingsSession.transcript.jumpToBottomTitle', descriptionKey: 'settingsSession.transcript.jumpToBottomSubtitle' },
            },
        },
        advanced: {
            titleKey: 'settingsSession.advanced.title',
            settings: {
                advanced: { titleKey: 'settingsSessionPages.transcript.advancedTitle', descriptionKey: 'settingsSessionPages.transcript.advancedLinkDescription' },
            },
        },
    },
});
