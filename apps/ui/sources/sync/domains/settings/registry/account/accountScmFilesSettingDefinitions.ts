import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function bucketCount(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

function bucketBytes(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

function serializeCountBucket(smallMax: number, mediumMax: number) {
    return (value: number) => bucketCount(value, smallMax, mediumMax);
}

function serializeBytesBucket(smallMax: number, mediumMax: number) {
    return (value: number) => bucketBytes(value, smallMax, mediumMax);
}

function buildOverrideCountSummaryProperties(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { overrideCount: 0 };
    }
    return { overrideCount: Object.keys(value as Record<string, unknown>).length };
}

export const ACCOUNT_SCM_FILES_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    scmCommitStrategy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmGitRepoPreferredBackend: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmGitRepoPreferredBackendQualifiedId: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmRemoteConfirmPolicy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmPushRejectPolicy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmUncommittedChangesStrategy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    scmDefaultDiffModeByBackend: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    },
    scmAskBeforeOverwritingBranchStash: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    scmReviewMaxFiles: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeCountBucket(25, 50),
    },
    scmReviewMaxChangedLines: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeCountBucket(2000, 4000),
    },
    scmDiffCacheMaxEntries: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeCountBucket(10, 30),
    },
    scmDiffCacheMaxTotalBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBytesBucket(10 * 1024 * 1024, 50 * 1024 * 1024),
    },
    scmReviewPrefetchAheadCountWeb: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(14, 24) },
    scmReviewPrefetchBehindCountWeb: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(4, 8) },
    scmReviewPrefetchAheadCountNative: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(8, 14) },
    scmReviewPrefetchBehindCountNative: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2, 4) },
    scmReviewPrefetchConcurrency: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(3, 5) },
    scmReviewPrefetchDebounceMs: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(50, 150) },
    scmSessionAutoRefreshIntervalMs: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(60000, 300000) },
    scmFilesAutoRefreshIntervalMs: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(15000, 60000) },
    scmCommitMessageGeneratorEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    'scm.diffSummary.enabled': { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    'scm.diffSummary.prefetch': { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    scmIncludeCoAuthoredBy: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    filesDiffSyntaxHighlightingMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    filesDiffRendererMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    filesDiffPresentationStyle: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    filesDiffFileListVirtualizationMinFiles: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeCountBucket(10, 30),
    },
    filesDiffInlineVirtualizationLineThreshold: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(400, 800) },
    filesDiffReviewCommentsInlineVirtualizationLineThreshold: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(120, 240) },
    filesDiffInlineVirtualizationByteThreshold: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(120000, 250000) },
    filesChangedFilesRowDensity: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    filesDiffFoldingEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    filesDiffFoldingContextThreshold: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(12, 24) },
    filesDiffFoldingContextRadius: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(3, 6) },
    filesDiffIntraLineWordDiffEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    filesDiffIntraLineWordDiffMaxPatchLines: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2000, 4000) },
    filesDiffIntraLineWordDiffMaxPairs: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(500, 800) },
    filesDiffIntraLineWordDiffMaxLineLength: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(800, 2000) },
    filesDiffTokenizationMaxBytes: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(250000, 500000) },
    filesDiffTokenizationMaxLines: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(5000, 10000) },
    filesDiffTokenizationMaxLineLength: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2000, 4000) },
    filesCodeViewJsonInferenceMaxBytes: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(40000, 80000) },
    filesRepositoryTreeWarmCacheEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    filesImagePreviewCacheMaxEntries: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(32, 64) },
    filesImagePreviewCacheMaxTotalBytes: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(96 * 1024 * 1024, 128 * 1024 * 1024) },
    filesImagePreviewMaxBytes: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(16 * 1024 * 1024, 32 * 1024 * 1024) },
    filesEditorAutoSave: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    markdownDefaultEditMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    filesMarkdownRichEditorMaxBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBytesBucket(256000, 512000),
    },
    filesMarkdownRichEditorHtmlRoundTripMaxBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBytesBucket(50000, 100000),
    },
    filesEditorChangeDebounceMs: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeCountBucket(100, 250),
    },
    filesEditorMaxFileBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBytesBucket(5000000, 8000000),
    },
    filesEditorBridgeMaxChunkBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeBytesBucket(64000, 96000),
    },
    filesEditorWebMonacoEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    filesEditorNativeCodeMirrorEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
});
