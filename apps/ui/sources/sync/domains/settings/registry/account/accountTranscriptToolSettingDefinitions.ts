import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';
import { DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';

export const TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES = [
    'hover_web_hidden_mobile',
    'hover_web_always_mobile',
    'always',
    'never',
] as const;
export type TranscriptMessageTimestampDisplayMode = typeof TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES[number];

function bucketCount(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax) return 'small';
    if (value <= mediumMax) return 'medium';
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

export const ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS = defineSettingDefinitions({
    toolViewDetailLevelDefault: {
        schema: z.enum(['default', 'title', 'compact', 'summary', 'full']),
        default: 'default',
        description: 'Default tool detail level in the session timeline',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    toolViewDetailLevelDefaultLocalControl: {
        schema: z.enum(['title', 'compact', 'summary', 'full']),
        default: 'title',
        description: 'Default tool detail level for local-control transcript mirroring',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    toolViewShowDebugByDefault: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to auto-expand debug/raw tool payloads in the full tool view',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    toolViewTapAction: {
        schema: z.enum(['expand', 'open']),
        default: 'expand',
        description: 'Primary tap action on tool cards (timeline)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    toolViewExpandedDetailLevelDefault: {
        schema: z.enum(['default', 'summary', 'full']),
        default: 'default',
        description: 'Default expanded tool detail level in the session timeline',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    toolViewDetailLevelByToolName: {
        schema: z.record(z.string(), z.enum(['title', 'compact', 'summary', 'full'])).default({}),
        default: {},
        description: 'Per-tool detail level overrides (keyed by canonical tool name)',
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
    toolViewExpandedDetailLevelByToolName: {
        schema: z.record(z.string(), z.enum(['summary', 'full'])).default({}),
        default: {},
        description: 'Per-tool expanded detail level overrides (keyed by canonical tool name)',
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
    transcriptGroupingMode: {
        schema: z.enum(['linear', 'turns']),
        default: 'turns',
        description: 'Transcript grouping mode (linear vs turn grouping)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    transcriptGroupToolCalls: {
        schema: z.boolean(),
        default: true,
        description: 'Group consecutive tool calls into a Tool calls section in the transcript',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptTurnToolCallsGroupStrategy: {
        schema: z.enum(['consecutive_tools', 'all_tools_in_turn']),
        default: 'consecutive_tools',
        description: 'Tool calls grouping strategy inside a turn',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    transcriptToolCallsCollapsedPreviewCount: {
        schema: z.number(),
        default: DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT,
        description: 'How many tool calls to preview when a Tool calls group is collapsed',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(3, 5),
        },
    },
    transcriptToolCallsGroupShowBackground: {
        schema: z.boolean(),
        default: true,
        description: 'When Tool calls are grouped and rendered in feed mode, show a group background behind the Tool calls',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMessageTimestampDisplayMode: {
        schema: z.enum(TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES),
        default: 'hover_web_hidden_mobile' satisfies TranscriptMessageTimestampDisplayMode,
        description: 'Controls when message time and date are shown below user and assistant transcript messages',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMessageSelectionEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show transcript message selection actions',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMessageSendToSessionEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Show transcript message Send to session bulk action',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMessageSendToSessionTemplate: {
        schema: z.string().max(2_000),
        default: '{{MESSAGES}}',
        description: 'Template applied when sending selected transcript messages to another session draft',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => bucketCount(typeof value === 'string' ? value.length : 0, 128, 512),
        },
    },
    transcriptBulkCopyFormat: {
        schema: z.enum(['markdown_labeled', 'plain']),
        default: 'markdown_labeled',
        description: 'Format used when copying selected transcript messages',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    transcriptPendingQueueMaxHeightPx: {
        schema: z.number(),
        default: 80,
        description: 'Max height (px) for the pending queue block in the transcript',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(80, 96),
        },
    },
    transcriptPendingQueueExpandedMaxHeightPx: {
        schema: z.number(),
        default: 520,
        description: 'Max height (px) for the pending queue block when expanded',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(400, 600),
        },
    },
    transcriptPendingQueueReorderRowHeightPx: {
        schema: z.number(),
        default: 72,
        description: 'Row height (px) used by drag reorder in the pending queue transcript block',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(60, 80),
        },
    },
    transcriptPendingMessageCollapseThresholdChars: {
        schema: z.number(),
        default: 160,
        description: 'Collapse pending messages longer than this many characters (0 disables)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(160, 320),
        },
    },
    transcriptPendingMessageCollapsedLines: {
        schema: z.number(),
        default: 2,
        description: 'Number of lines shown when a pending message is collapsed',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(2, 4),
        },
    },
    transcriptStreamingCoalesceEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Whether transcript streaming updates are coalesced into frame-sized batches',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptStreamingCoalesceWindowMs: {
        schema: z.number(),
        default: 16,
        description: 'Coalescing window for transcript streaming (ms)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(16, 33),
        },
    },
    transcriptStreamingCoalesceMaxBatchSize: {
        schema: z.number(),
        default: 200,
        description: 'Maximum message batch size per coalesced flush',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(200, 350),
        },
    },
    transcriptThinkingPulseStaleMs: {
        schema: z.number(),
        default: 120_000,
        description: 'Stale window for thinking pulse to auto-clear (ms)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(120_000, 240_000),
        },
    },
    // `transcriptListImplementation` is intentionally not a dev setting. Stable
    // ui-web-v0.2.0, preview ui-web-v0.2.2-preview.1775585938.1, and the current
    // remote-dev predecessor can still persist it for their Flash fallback.
    // The account parser preserves it only as an opaque unknown field. Remove
    // that compatibility assertion after those releases are unsupported and
    // remote-dev no longer writes the key.
    toolViewTimelineChromeMode: {
        schema: z.enum(['cards', 'activity_feed']),
        default: 'activity_feed',
        description: 'Tool timeline chrome mode (cards vs activity feed rows)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    toolViewTimelineFeedDefaultExpanded: {
        schema: z.boolean(),
        default: false,
        description: 'Default expansion state for activity feed tool rows',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMotionPreset: {
        schema: z.enum(['off', 'subtle', 'full']),
        default: 'subtle',
        description: 'Transcript animation preset',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    transcriptMotionFreshnessMs: {
        schema: z.number(),
        default: 60_000,
        description: 'Freshness window for transcript animations (ms)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(15_000, 60_000),
        },
    },
    transcriptAnimateNewItemsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Animate streamed-in transcript items',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptAnimateToolExpandCollapseEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Animate tool expand/collapse in the transcript',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptAnimateToolExpandCollapseFreshOnly: {
        schema: z.boolean(),
        default: true,
        description: 'Only animate tool expand/collapse when the tool is fresh',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptAnimateThinkingEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Animate streamed thinking messages (when visible)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptStreamingSmoothingEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Smooth streaming agent message rendering (avoid expensive markdown parsing while streaming)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptStreamingSettleDelayMs: {
        schema: z.number(),
        default: 250,
        description: 'Delay (ms) after last text update before switching back to full markdown rendering',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(150, 250),
        },
    },
    transcriptStreamingPartialOutputEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show partial assistant text while streaming (when disabled, reveal text only after completion)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptStreamingMarkdownRenderingEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Render repaired Markdown while assistant text is actively streaming',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptScrollPinEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable scroll pin behavior (pinned/unpinned) in the transcript',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptScrollPinOffsetThresholdPx: {
        schema: z.number(),
        default: 72,
        description: 'Pinned offset threshold (px) for transcript scroll pin',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(72, 120),
        },
    },
    transcriptScrollAutoFollowWhenPinned: {
        schema: z.boolean(),
        default: true,
        description: 'Auto-follow new transcript items while pinned',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptScrollJumpToBottomEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show jump-to-bottom button when unpinned and new items arrive',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    transcriptScrollJumpToBottomMinNewCount: {
        schema: z.number(),
        default: 1,
        description: 'Minimum new items count to show jump-to-bottom button',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: serializeBucketCount(1, 3),
        },
    },
    transcriptScrollJumpToBottomRevealViewportRatio: {
        schema: z.number(),
        default: 0.4,
        description: 'Viewport fraction away from the transcript bottom before showing jump-to-bottom button',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
            serializeCurrent: (value: number) => bucketCount(Math.round(value * 100), 50, 100),
        },
    },
    transcriptScrollJumpToBottomAnimateScroll: {
        schema: z.boolean(),
        default: true,
        description: 'Animate scroll when jumping to bottom',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    permissionPromptSurface: {
        schema: z.enum(['composer', 'transcript', 'both']),
        default: 'composer',
        description: 'Where permission prompts are displayed (composer, transcript, or both)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
});

export const ACCOUNT_TRANSCRIPT_TOOL_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS);
