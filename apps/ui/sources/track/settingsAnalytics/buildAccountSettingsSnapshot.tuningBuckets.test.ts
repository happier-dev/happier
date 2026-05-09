import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks bucketed transcript performance tuning settings through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            transcriptToolCallsCollapsedPreviewCount: 10,
            transcriptPendingQueueMaxHeightPx: 120,
            transcriptPendingQueueExpandedMaxHeightPx: 700,
            transcriptPendingQueueReorderRowHeightPx: 48,
            transcriptPendingMessageCollapseThresholdChars: 400,
            transcriptPendingMessageCollapsedLines: 5,
            transcriptStreamingCoalesceWindowMs: 50,
            transcriptStreamingCoalesceMaxBatchSize: 500,
            transcriptThinkingPulseStaleMs: 300_000,
            transcriptMotionFreshnessMs: 10_000,
            transcriptScrollPinOffsetThresholdPx: 200,
            transcriptScrollJumpToBottomMinNewCount: 5,
        });

        expect(snapshot.properties.acct_setting__transcriptToolCallsCollapsedPreviewCount).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptPendingQueueMaxHeightPx).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptPendingQueueExpandedMaxHeightPx).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptPendingQueueReorderRowHeightPx).toBe('small');
        expect(snapshot.properties.acct_setting__transcriptPendingMessageCollapseThresholdChars).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptPendingMessageCollapsedLines).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptStreamingCoalesceWindowMs).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptStreamingCoalesceMaxBatchSize).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptThinkingPulseStaleMs).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptMotionFreshnessMs).toBe('small');
        expect(snapshot.properties.acct_setting__transcriptScrollPinOffsetThresholdPx).toBe('large');
        expect(snapshot.properties.acct_setting__transcriptScrollJumpToBottomMinNewCount).toBe('large');
    });

    it('tracks bucketed numeric replay, attachment, scm, and editor tuning settings through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            scmReviewMaxFiles: 80,
            scmReviewMaxChangedLines: 5_000,
            scmDiffCacheMaxEntries: 5,
            scmDiffCacheMaxTotalBytes: 100 * 1024 * 1024,
            scmReviewPrefetchAheadCountWeb: 40,
            scmReviewPrefetchBehindCountWeb: 2,
            scmReviewPrefetchAheadCountNative: 20,
            scmReviewPrefetchBehindCountNative: 1,
            scmReviewPrefetchConcurrency: 6,
            scmReviewPrefetchDebounceMs: 20,
            scmSessionAutoRefreshIntervalMs: 15 * 60 * 1000,
            scmFilesAutoRefreshIntervalMs: 10 * 1000,
            filesDiffFileListVirtualizationMinFiles: 5,
            filesDiffInlineVirtualizationLineThreshold: 1_000,
            filesDiffInlineVirtualizationByteThreshold: 500_000,
            filesDiffFoldingContextThreshold: 40,
            filesDiffFoldingContextRadius: 8,
            filesDiffIntraLineWordDiffMaxPatchLines: 5_000,
            filesDiffIntraLineWordDiffMaxPairs: 1_000,
            filesDiffIntraLineWordDiffMaxLineLength: 4_000,
            filesDiffTokenizationMaxBytes: 1_000_000,
            filesDiffTokenizationMaxLines: 20_000,
            filesDiffTokenizationMaxLineLength: 8_000,
            filesCodeViewJsonInferenceMaxBytes: 100_000,
            filesImagePreviewCacheMaxEntries: 100,
            filesImagePreviewCacheMaxTotalBytes: 50 * 1024 * 1024,
            filesImagePreviewMaxBytes: 10 * 1024 * 1024,
            filesEditorChangeDebounceMs: 50,
            filesEditorMaxFileBytes: 10_000_000,
            filesEditorBridgeMaxChunkBytes: 128_000,
            sessionReplayRecentMessagesCount: 600,
            sessionReplayMaxSeedChars: 300_000,
            executionRunsGuidanceMaxChars: 6_000,
            attachmentsUploadsMaxFileBytes: 100 * 1024 * 1024,
        });

        expect(snapshot.properties.acct_setting__scmReviewMaxFiles).toBe('large');
        expect(snapshot.properties.acct_setting__scmReviewMaxChangedLines).toBe('large');
        expect(snapshot.properties.acct_setting__scmDiffCacheMaxEntries).toBe('small');
        expect(snapshot.properties.acct_setting__scmDiffCacheMaxTotalBytes).toBe('large');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchAheadCountWeb).toBe('large');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchBehindCountWeb).toBe('small');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchAheadCountNative).toBe('large');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchBehindCountNative).toBe('small');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchConcurrency).toBe('large');
        expect(snapshot.properties.acct_setting__scmReviewPrefetchDebounceMs).toBe('small');
        expect(snapshot.properties.acct_setting__scmSessionAutoRefreshIntervalMs).toBe('large');
        expect(snapshot.properties.acct_setting__scmFilesAutoRefreshIntervalMs).toBe('small');
        expect(snapshot.properties.acct_setting__filesDiffFileListVirtualizationMinFiles).toBe('small');
        expect(snapshot.properties.acct_setting__filesDiffInlineVirtualizationLineThreshold).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffInlineVirtualizationByteThreshold).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffFoldingContextThreshold).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffFoldingContextRadius).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffIntraLineWordDiffMaxPatchLines).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffIntraLineWordDiffMaxPairs).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffIntraLineWordDiffMaxLineLength).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffTokenizationMaxBytes).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffTokenizationMaxLines).toBe('large');
        expect(snapshot.properties.acct_setting__filesDiffTokenizationMaxLineLength).toBe('large');
        expect(snapshot.properties.acct_setting__filesCodeViewJsonInferenceMaxBytes).toBe('large');
        expect(snapshot.properties.acct_setting__filesImagePreviewCacheMaxEntries).toBe('large');
        expect(snapshot.properties.acct_setting__filesImagePreviewCacheMaxTotalBytes).toBe('small');
        expect(snapshot.properties.acct_setting__filesImagePreviewMaxBytes).toBe('medium');
        expect(snapshot.properties.acct_setting__filesEditorChangeDebounceMs).toBe('small');
        expect(snapshot.properties.acct_setting__filesEditorMaxFileBytes).toBe('large');
        expect(snapshot.properties.acct_setting__filesEditorBridgeMaxChunkBytes).toBe('large');
        expect(snapshot.properties.acct_setting__sessionReplayRecentMessagesCount).toBe('large');
        expect(snapshot.properties.acct_setting__sessionReplayMaxSeedChars).toBe('large');
        expect(snapshot.properties.acct_setting__executionRunsGuidanceMaxChars).toBe('large');
        expect(snapshot.properties.acct_setting__attachmentsUploadsMaxFileBytes).toBe('large');
    });
});
