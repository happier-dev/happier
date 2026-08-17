import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function bucketCount(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

function serializeBucketCount(smallMax: number, mediumMax: number) {
    return (value: number) => bucketCount(value, smallMax, mediumMax);
}

function buildOverrideCountSummaryProperties(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { overrideCount: 0 };
    }
    return { overrideCount: Object.keys(value as Record<string, unknown>).length };
}

export const ACCOUNT_TRANSCRIPT_TOOL_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    toolViewDetailLevelDefault: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    toolViewDetailLevelDefaultLocalControl: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    toolViewShowDebugByDefault: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    toolViewTapAction: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    toolViewExpandedDetailLevelDefault: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    toolViewDetailLevelByToolName: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    },
    toolViewExpandedDetailLevelByToolName: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    },
    transcriptGroupingMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    transcriptGroupToolCalls: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptTurnToolCallsGroupStrategy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    transcriptToolCallsCollapsedPreviewCount: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(3, 5),
    },
    transcriptToolCallsGroupShowBackground: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptMessageTimestampDisplayMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    transcriptMessageSelectionEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptMessageSendToSessionEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptMessageSendToSessionTemplate: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => bucketCount(typeof value === 'string' ? value.length : 0, 128, 512),
    },
    transcriptBulkCopyFormat: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    transcriptPendingQueueMaxHeightPx: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(80, 96),
    },
    transcriptPendingQueueExpandedMaxHeightPx: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(400, 600),
    },
    transcriptPendingQueueReorderRowHeightPx: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(60, 80),
    },
    transcriptPendingMessageCollapseThresholdChars: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(160, 320),
    },
    transcriptPendingMessageCollapsedLines: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(2, 4),
    },
    transcriptStreamingCoalesceEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptStreamingCoalesceWindowMs: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(16, 33),
    },
    transcriptStreamingCoalesceMaxBatchSize: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(200, 350),
    },
    transcriptThinkingPulseStaleMs: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(120000, 240000),
    },
    toolViewTimelineChromeMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    toolViewTimelineFeedDefaultExpanded: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptMotionPreset: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    transcriptMotionFreshnessMs: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(15000, 60000),
    },
    transcriptAnimateNewItemsEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptAnimateToolExpandCollapseEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptAnimateToolExpandCollapseFreshOnly: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptAnimateThinkingEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptStreamingSmoothingEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptStreamingSettleDelayMs: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(150, 250),
    },
    transcriptStreamingPartialOutputEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptStreamingMarkdownRenderingEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptScrollPinEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptScrollPinOffsetThresholdPx: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(72, 120),
    },
    transcriptScrollAutoFollowWhenPinned: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptScrollJumpToBottomEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    transcriptScrollJumpToBottomMinNewCount: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBucketCount(1, 3),
    },
    transcriptScrollJumpToBottomRevealViewportRatio: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketCount(Math.round(value * 100), 50, 100),
    },
    transcriptScrollJumpToBottomAnimateScroll: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    permissionPromptSurface: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
});
