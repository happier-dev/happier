import {
    ACCOUNT_SETTING_ARTIFACTS as PROTOCOL_ACCOUNT_SETTING_ARTIFACTS,
    ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
    accountSettingsParse,
} from '@happier-dev/protocol';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_SETTING_ARTIFACTS } from './registry/account/accountSettingArtifacts';
import { SUPPORTED_SCHEMA_VERSION, settingsParse } from './settings';

// These keys were previously declared only by the UI persistence catalog. They are all
// account-scoped preferences; the three device-local new-session "last used" keys are
// intentionally absent and move to the separate local-only catalog.
const PREVIOUSLY_UI_ONLY_ACCOUNT_KEYS = [
    'externalSessionsSettingsV1',
    'filesChangedFilesRowDensity',
    'filesCodeViewJsonInferenceMaxBytes',
    'filesDiffFileListVirtualizationMinFiles',
    'filesDiffFoldingContextRadius',
    'filesDiffFoldingContextThreshold',
    'filesDiffFoldingEnabled',
    'filesDiffInlineVirtualizationByteThreshold',
    'filesDiffInlineVirtualizationLineThreshold',
    'filesDiffIntraLineWordDiffEnabled',
    'filesDiffIntraLineWordDiffMaxLineLength',
    'filesDiffIntraLineWordDiffMaxPairs',
    'filesDiffIntraLineWordDiffMaxPatchLines',
    'filesDiffPresentationStyle',
    'filesDiffRendererMode',
    'filesDiffReviewCommentsInlineVirtualizationLineThreshold',
    'filesDiffSyntaxHighlightingMode',
    'filesDiffTokenizationMaxBytes',
    'filesDiffTokenizationMaxLineLength',
    'filesDiffTokenizationMaxLines',
    'filesEditorAutoSave',
    'filesEditorBridgeMaxChunkBytes',
    'filesEditorChangeDebounceMs',
    'filesEditorMaxFileBytes',
    'filesEditorNativeCodeMirrorEnabled',
    'filesEditorWebMonacoEnabled',
    'filesImagePreviewCacheMaxEntries',
    'filesImagePreviewCacheMaxTotalBytes',
    'filesImagePreviewMaxBytes',
    'filesMarkdownRichEditorHtmlRoundTripMaxBytes',
    'filesMarkdownRichEditorMaxBytes',
    'filesRepositoryTreeWarmCacheEnabled',
    'installablesPolicyByMachineId',
    'markdownDefaultEditMode',
    'permissionPromptSurface',
    'preferredLanguage',
    'scm.diffSummary.enabled',
    'scm.diffSummary.modelProfileOverride',
    'scm.diffSummary.prefetch',
    'scmAskBeforeOverwritingBranchStash',
    'scmCommitMessageGeneratorBackendId',
    'scmCommitMessageGeneratorEnabled',
    'scmCommitMessageGeneratorInstructions',
    'scmCommitStrategy',
    'scmDefaultDiffModeByBackend',
    'scmDiffCacheMaxEntries',
    'scmDiffCacheMaxTotalBytes',
    'scmFilesAutoRefreshIntervalMs',
    'scmGitRepoPreferredBackend',
    'scmGitRepoPreferredBackendQualifiedId',
    'scmPushRejectPolicy',
    'scmRemoteConfirmPolicy',
    'scmReviewMaxChangedLines',
    'scmReviewMaxFiles',
    'scmReviewPrefetchAheadCountNative',
    'scmReviewPrefetchAheadCountWeb',
    'scmReviewPrefetchBehindCountNative',
    'scmReviewPrefetchBehindCountWeb',
    'scmReviewPrefetchConcurrency',
    'scmReviewPrefetchDebounceMs',
    'scmSessionAutoRefreshIntervalMs',
    'scmUncommittedChangesStrategy',
    'sessionHandoffDefaultsV1',
    'sessionReplaySummaryRunnerV1',
    'sessionTmuxByMachineId',
    'sessionTmuxIsolated',
    'sessionTmuxSessionName',
    'sessionTmuxTmpDir',
    'toolViewDetailLevelByToolName',
    'toolViewDetailLevelDefault',
    'toolViewDetailLevelDefaultLocalControl',
    'toolViewExpandedDetailLevelByToolName',
    'toolViewExpandedDetailLevelDefault',
    'toolViewShowDebugByDefault',
    'toolViewTapAction',
    'toolViewTimelineChromeMode',
    'toolViewTimelineFeedDefaultExpanded',
    'transcriptAnimateNewItemsEnabled',
    'transcriptAnimateThinkingEnabled',
    'transcriptAnimateToolExpandCollapseEnabled',
    'transcriptAnimateToolExpandCollapseFreshOnly',
    'transcriptBulkCopyFormat',
    'transcriptGroupToolCalls',
    'transcriptGroupingMode',
    'transcriptMessageSelectionEnabled',
    'transcriptMessageSendToSessionEnabled',
    'transcriptMessageSendToSessionTemplate',
    'transcriptMessageTimestampDisplayMode',
    'transcriptMotionFreshnessMs',
    'transcriptMotionPreset',
    'transcriptPendingMessageCollapseThresholdChars',
    'transcriptPendingMessageCollapsedLines',
    'transcriptPendingQueueExpandedMaxHeightPx',
    'transcriptPendingQueueMaxHeightPx',
    'transcriptPendingQueueReorderRowHeightPx',
    'transcriptScrollAutoFollowWhenPinned',
    'transcriptScrollJumpToBottomAnimateScroll',
    'transcriptScrollJumpToBottomEnabled',
    'transcriptScrollJumpToBottomMinNewCount',
    'transcriptScrollJumpToBottomRevealViewportRatio',
    'transcriptScrollPinEnabled',
    'transcriptScrollPinOffsetThresholdPx',
    'transcriptStreamingCoalesceEnabled',
    'transcriptStreamingCoalesceMaxBatchSize',
    'transcriptStreamingCoalesceWindowMs',
    'transcriptStreamingMarkdownRenderingEnabled',
    'transcriptStreamingPartialOutputEnabled',
    'transcriptStreamingSettleDelayMs',
    'transcriptStreamingSmoothingEnabled',
    'transcriptThinkingPulseStaleMs',
    'transcriptToolCallsCollapsedPreviewCount',
    'transcriptToolCallsGroupShowBackground',
    'transcriptTurnToolCallsGroupStrategy',
] as const;

describe('Protocol-owned Account Settings catalog', () => {
    it('validates each current settings input once while accepting changes and recovering malformed values', () => {
        // Measure the canonical schema boundary without replacing its validation.
        const parse = vi.spyOn(AccountSettingsSchema, 'parse');
        try {
            for (let index = 0; index < 40; index += 1) settingsParse({ filesEditorAutoSave: false });
            expect(parse).toHaveBeenCalledTimes(40);
            expect(settingsParse({ filesEditorAutoSave: true }).filesEditorAutoSave).toBe(true);
            expect(settingsParse({ filesEditorAutoSave: 'invalid' }).filesEditorAutoSave)
                .toBe(PROTOCOL_ACCOUNT_SETTING_ARTIFACTS.defaults.filesEditorAutoSave);
            expect(parse).toHaveBeenCalledTimes(42);
        } finally {
            parse.mockRestore();
        }
    });
    it('owns every formerly UI-only Account key and its canonical defaults', () => {
        for (const key of PREVIOUSLY_UI_ONLY_ACCOUNT_KEYS) {
            expect(PROTOCOL_ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty(key);
            expect(PROTOCOL_ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty(key);
        }

        expect(PROTOCOL_ACCOUNT_SETTING_ARTIFACTS.defaults).toMatchObject({
            executionRunsGuidanceEnabled: true,
            scmCommitStrategy: 'atomic',
            filesDiffRendererMode: 'pierre',
            transcriptGroupingMode: 'turns',
            transcriptToolCallsCollapsedPreviewCount: 3,
            sessionTmuxSessionName: 'happy',
            sessionHandoffDefaultsV1: {
                v: 1,
                workspaceSyncMode: 'keep_synced',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
                directTargetMode: 'keep_direct',
            },
        });
    });

    it('uses the Protocol artifact and version rather than rebuilding a UI persistence catalog', () => {
        expect(ACCOUNT_SETTING_ARTIFACTS).toBe(PROTOCOL_ACCOUNT_SETTING_ARTIFACTS);
        expect(SUPPORTED_SCHEMA_VERSION).toBe(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION);
    });

    it('recovers malformed known entries identically at the Protocol and UI boundaries', () => {
        const input = {
            filesDiffRendererMode: 'unrecognized-renderer',
            scmCommitStrategy: 'unrecognized-strategy',
            transcriptGroupingMode: 'unrecognized-grouping',
            futureWriterKey: { retained: true },
            providerSettingsV1: { futureProvider: { opaque: ['exact'] } },
        };

        const protocol = accountSettingsParse(input);
        const ui = settingsParse(input);

        expect(ui).toMatchObject({
            filesDiffRendererMode: protocol.filesDiffRendererMode,
            scmCommitStrategy: protocol.scmCommitStrategy,
            transcriptGroupingMode: protocol.transcriptGroupingMode,
            futureWriterKey: protocol.futureWriterKey,
            providerSettingsV1: protocol.providerSettingsV1,
        });
    });
});
