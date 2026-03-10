import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

import { SCM_COMMIT_STRATEGIES } from '@/scm/settings/commitStrategy';
import {
    SCM_DIFF_MODE_OPTIONS,
    SCM_GIT_REPO_BACKEND_OPTIONS,
    SCM_PUSH_REJECT_POLICIES,
    SCM_REMOTE_CONFIRM_POLICIES,
} from '@/scm/settings/preferences';

function bucketCount(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax) return 'small';
    if (value <= mediumMax) return 'medium';
    return 'large';
}

function bucketBytes(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax) return 'small';
    if (value <= mediumMax) return 'medium';
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

export const ACCOUNT_SCM_FILES_SETTING_DEFINITIONS = defineSettingDefinitions({
    scmCommitStrategy: {
        schema: z.enum(SCM_COMMIT_STRATEGIES),
        default: 'atomic',
        description: 'Source-control commit strategy: atomic working-copy commit or live Git staging',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    scmGitRepoPreferredBackend: {
        schema: z.enum(SCM_GIT_REPO_BACKEND_OPTIONS),
        default: 'git',
        description: 'Preferred backend for .git repositories',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    scmRemoteConfirmPolicy: {
        schema: z.enum(SCM_REMOTE_CONFIRM_POLICIES),
        default: 'always',
        description: 'Confirmation policy for SCM remote pull/push operations',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    scmPushRejectPolicy: {
        schema: z.enum(SCM_PUSH_REJECT_POLICIES),
        default: 'prompt_fetch',
        description: 'Behavior when push is rejected as non-fast-forward',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    scmUncommittedChangesStrategy: {
        schema: z.enum(['ask', 'always_bring', 'always_stash']),
        default: 'ask',
        description: 'How to handle uncommitted changes when switching branches',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    scmDefaultDiffModeByBackend: {
        schema: z.record(z.string(), z.enum(SCM_DIFF_MODE_OPTIONS)).default({}),
        default: {},
        description: 'Preferred default diff mode by backend id',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildOverrideCountSummaryProperties,
        },
    },
    scmAskBeforeOverwritingBranchStash: {
        schema: z.boolean(),
        default: true,
        description: 'Ask before overwriting an existing per-branch stash when switching branches (stash strategy)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    scmReviewMaxFiles: {
        schema: z.number(),
        default: 25,
        description: 'Maximum file count for unified SCM diff review mode before falling back to single-file review',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeCountBucket(25, 50),
        },
    },
    scmReviewMaxChangedLines: {
        schema: z.number(),
        default: 2_000,
        description: 'Maximum total changed lines for unified SCM diff review mode before falling back to single-file review',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeCountBucket(2_000, 4_000),
        },
    },
    scmDiffCacheMaxEntries: {
        schema: z.number(),
        default: 30,
        description: 'Maximum number of SCM diffs to keep in the session diff cache',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeCountBucket(10, 30),
        },
    },
    scmDiffCacheMaxTotalBytes: {
        schema: z.number(),
        default: 20 * 1024 * 1024,
        description: 'Maximum total bytes to keep in the session diff cache (best-effort; based on UTF-16 size)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBytesBucket(10 * 1024 * 1024, 50 * 1024 * 1024),
        },
    },
    scmReviewPrefetchAheadCountWeb: {
        schema: z.number(),
        default: 14,
        description: 'How many SCM file diffs to prefetch ahead of the visible window in Review (web/tablet/desktop)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(14, 24) },
    },
    scmReviewPrefetchBehindCountWeb: {
        schema: z.number(),
        default: 8,
        description: 'How many SCM file diffs to prefetch behind the visible window in Review (web/tablet/desktop)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(4, 8) },
    },
    scmReviewPrefetchAheadCountNative: {
        schema: z.number(),
        default: 8,
        description: 'How many SCM file diffs to prefetch ahead of the visible window in Review (native mobile)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(8, 14) },
    },
    scmReviewPrefetchBehindCountNative: {
        schema: z.number(),
        default: 4,
        description: 'How many SCM file diffs to prefetch behind the visible window in Review (native mobile)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2, 4) },
    },
    scmReviewPrefetchConcurrency: {
        schema: z.number(),
        default: 3,
        description: 'Maximum concurrent SCM diff prefetch requests in Review',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(3, 5) },
    },
    scmReviewPrefetchDebounceMs: {
        schema: z.number(),
        default: 150,
        description: 'Debounce milliseconds for Review viewability-driven prefetch window updates',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(50, 150) },
    },
    scmSessionAutoRefreshIntervalMs: {
        schema: z.number(),
        default: 300_000,
        description: 'Auto-refresh interval for SCM status while viewing a session (milliseconds)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(60_000, 300_000) },
    },
    scmFilesAutoRefreshIntervalMs: {
        schema: z.number(),
        default: 60_000,
        description: 'Auto-refresh interval for SCM status while viewing the Files screen (milliseconds)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(15_000, 60_000) },
    },
    scmCommitMessageGeneratorEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable one-shot LLM commit message generation in the source-control commit flow',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    scmCommitMessageGeneratorBackendId: {
        schema: z.string(),
        default: 'claude',
        description: 'Backend id used for one-shot LLM commit message generation',
        storageScope: 'account',
    },
    scmCommitMessageGeneratorInstructions: {
        schema: z.string(),
        default: '',
        description: 'User instructions appended to SCM commit message generation prompts',
        storageScope: 'account',
    },
    scmIncludeCoAuthoredBy: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to include Co-Authored-By credits in generated commit messages',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffSyntaxHighlightingMode: {
        schema: z.enum(['off', 'simple', 'advanced']),
        default: 'simple',
        description: 'Diff/file syntax highlighting mode',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffRendererMode: {
        schema: z.enum(['happier', 'pierre']),
        default: 'pierre',
        description: 'Diff renderer mode (web/desktop); native always uses happier',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffPresentationStyle: {
        schema: z.enum(['unified', 'split']),
        default: 'unified',
        description: 'Diff presentation style (web/desktop); split enables side-by-side rendering when supported',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffFileListVirtualizationMinFiles: {
        schema: z.number(),
        default: 20,
        description: 'Minimum file count to virtualize diff file lists (tool diffs, commit diffs, review surfaces)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeCountBucket(10, 30),
        },
    },
    filesDiffInlineVirtualizationLineThreshold: {
        schema: z.number(),
        default: 400,
        description: 'Line threshold for enabling inline diff virtualization (per-file inline diffs)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(400, 800) },
    },
    filesDiffInlineVirtualizationByteThreshold: {
        schema: z.number(),
        default: 120_000,
        description: 'Byte threshold for enabling inline diff virtualization (per-file inline diffs)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(120_000, 250_000) },
    },
    filesChangedFilesRowDensity: {
        schema: z.enum(['comfortable', 'compact']),
        default: 'comfortable',
        description: 'Row density for changed files list and review',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffFoldingEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to fold large unchanged context blocks inside unified diffs (best-effort)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffFoldingContextThreshold: {
        schema: z.number(),
        default: 12,
        description: 'Minimum contiguous context-line run length before folding is applied',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(12, 24) },
    },
    filesDiffFoldingContextRadius: {
        schema: z.number(),
        default: 3,
        description: 'Number of context lines to keep at the start and end of a folded block',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(3, 6) },
    },
    filesDiffIntraLineWordDiffEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to compute best-effort intra-line word diffs for paired remove/add lines in unified diffs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesDiffIntraLineWordDiffMaxPatchLines: {
        schema: z.number(),
        default: 2_000,
        description: 'Maximum patch line count to compute intra-line word diffs before falling back to whole-line diffs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2_000, 4_000) },
    },
    filesDiffIntraLineWordDiffMaxPairs: {
        schema: z.number(),
        default: 500,
        description: 'Maximum remove/add pairs to compute intra-line word diffs for (per diff)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(500, 800) },
    },
    filesDiffIntraLineWordDiffMaxLineLength: {
        schema: z.number(),
        default: 800,
        description: 'Maximum per-line length to compute intra-line word diffs for',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(800, 2_000) },
    },
    filesDiffTokenizationMaxBytes: {
        schema: z.number(),
        default: 250_000,
        description: 'Maximum bytes to tokenize before falling back to plain text',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(250_000, 500_000) },
    },
    filesDiffTokenizationMaxLines: {
        schema: z.number(),
        default: 5_000,
        description: 'Maximum line count to tokenize before falling back to plain text',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(5_000, 10_000) },
    },
    filesDiffTokenizationMaxLineLength: {
        schema: z.number(),
        default: 2_000,
        description: 'Maximum per-line length to tokenize before falling back to plain text for that line',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(2_000, 4_000) },
    },
    filesCodeViewJsonInferenceMaxBytes: {
        schema: z.number(),
        default: 40_000,
        description: 'Maximum bytes to attempt JSON.parse for CodeView language inference (best-effort)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(40_000, 80_000) },
    },
    filesRepositoryTreeWarmCacheEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to warm the repository tree directory cache while viewing a session (web only)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesImagePreviewCacheMaxEntries: {
        schema: z.number(),
        default: 20,
        description: 'Maximum number of image previews to keep in the in-app file preview cache',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeCountBucket(20, 50) },
    },
    filesImagePreviewCacheMaxTotalBytes: {
        schema: z.number(),
        default: 10 * 1024 * 1024,
        description: 'Maximum total bytes for cached image previews (best-effort; based on UTF-16 size)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(10 * 1024 * 1024, 25 * 1024 * 1024) },
    },
    filesImagePreviewMaxBytes: {
        schema: z.number(),
        default: 3 * 1024 * 1024,
        description: 'Maximum bytes for a single in-app image preview (best-effort; based on UTF-16 size)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeBytesBucket(3 * 1024 * 1024, 6 * 1024 * 1024) },
    },
    filesEditorAutoSave: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to auto-save in the embedded editor',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesEditorChangeDebounceMs: {
        schema: z.number(),
        default: 250,
        description: 'Debounce milliseconds for editor change propagation',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeCountBucket(100, 250),
        },
    },
    filesEditorMaxFileBytes: {
        schema: z.number(),
        default: 2_500_000,
        description: 'Maximum file size supported for editing in UI',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBytesBucket(5_000_000, 8_000_000),
        },
    },
    filesEditorBridgeMaxChunkBytes: {
        schema: z.number(),
        default: 64_000,
        description: 'Maximum chunk size for editor WebView bridge payloads',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBytesBucket(64_000, 96_000),
        },
    },
    filesEditorWebMonacoEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Kill switch: enable Monaco editor surface on web/desktop',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    filesEditorNativeCodeMirrorEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Kill switch: enable CodeMirror WebView surface on native',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
});

export const ACCOUNT_SCM_FILES_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_SCM_FILES_SETTING_DEFINITIONS);
