import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

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

export const ACCOUNT_DISPLAY_SETTING_DEFINITIONS = defineSettingDefinitions({
    sessionThinkingDisplayMode: {
        schema: z.enum(['inline', 'tool', 'hidden']),
        default: 'inline',
        description: 'How to display agent thinking messages in the transcript',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionThinkingInlinePresentation: {
        schema: z.enum(['full', 'summary']),
        default: 'summary',
        description: 'When thinking is inline, whether to show a full body or a summary-only row',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionThinkingInlineChrome: {
        schema: z.enum(['plain', 'card']),
        default: 'plain',
        description: 'When thinking is inline, whether to show chrome (card) or render plainly',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    showLineNumbers: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to show line numbers in diffs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    showLineNumbersInToolViews: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to show line numbers in tool view diffs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    wrapLinesInDiffs: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to wrap long lines in diff views',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionReplayStrategy: {
        schema: z.enum(['recent_messages', 'summary_plus_recent']),
        default: 'recent_messages',
        description: 'Replay strategy used for app-level transcript replay',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionReplayRecentMessagesCount: {
        schema: z.number(),
        default: 250,
        description: 'Number of recent transcript messages included in app-level replay context',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketCount(value, 100, 300),
        },
    },
    sessionReplayMaxSeedChars: {
        schema: z.number(),
        default: 120_000,
        description: 'Maximum character budget for replay seed prompts (best-effort; oldest items dropped first)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketCount(value, 80_000, 200_000),
        },
    },
    executionRunsGuidanceEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable execution-run guidance injection into the session system prompt',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    executionRunsGuidanceMaxChars: {
        schema: z.number(),
        default: 4_000,
        description: 'Max character budget for execution-run guidance injection',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketCount(value, 2_000, 5_000),
        },
    },
    attachmentsUploadsUploadLocation: {
        schema: z.enum(['workspace', 'os_temp']),
        default: 'workspace',
        description: 'Where to store uploaded attachments (workspace or OS temp)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    attachmentsUploadsWorkspaceRelativeDir: {
        schema: z.string(),
        default: '.happier/uploads',
        description: 'Workspace-relative directory for attachments when uploadLocation=workspace',
        storageScope: 'account',
    },
    attachmentsUploadsVcsIgnoreStrategy: {
        schema: z.enum(['git_info_exclude', 'gitignore', 'none']),
        default: 'git_info_exclude',
        description: 'VCS ignore strategy for workspace uploads',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    attachmentsUploadsVcsIgnoreWritesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Whether the app should attempt to write VCS ignore rules (best-effort)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    attachmentsUploadsMaxFileBytes: {
        schema: z.number(),
        default: 25 * 1024 * 1024,
        description: 'Maximum allowed attachment size (bytes)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketBytes(value, 10 * 1024 * 1024, 50 * 1024 * 1024),
        },
    },
    attachmentsUploadsUploadTtlMs: {
        schema: z.number(),
        default: 5 * 60 * 1000,
        description: 'Upload session TTL (milliseconds)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketCount(value, 2 * 60 * 1000, 10 * 60 * 1000),
        },
    },
    attachmentsUploadsChunkSizeBytes: {
        schema: z.number(),
        default: 256 * 1024,
        description: 'Preferred upload chunk size (bytes)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketBytes(value, 128 * 1024, 512 * 1024),
        },
    },
    serverSelectionActiveTargetKind: {
        schema: z.enum(['server', 'group']).nullable(),
        default: null,
        description: 'Explicit active server selection target kind (server/group)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'presence', privacy: 'safe', identityScope: 'person' },
    },
    sessionTagsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show tag controls in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    terminalConnectLegacySecretExportEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Allow terminal connect to fall back to exporting the legacy auth secret (compatibility mode)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
});

export const ACCOUNT_DISPLAY_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_DISPLAY_SETTING_DEFINITIONS);
