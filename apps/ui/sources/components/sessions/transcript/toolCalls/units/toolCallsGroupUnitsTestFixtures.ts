import { createReducer } from '@/sync/reducer/reducer';
import type {
    TranscriptSessionCommonProps,
    TranscriptToolChromeCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

export function createTranscriptSessionCommonPropsFixture(overrides?: Readonly<{
    toolChromeCommon?: Partial<TranscriptToolChromeCommon>;
}>): TranscriptSessionCommonProps {
    return {
        forkCommon: {
            executionRunsEnabled: false,
            sessionForkSupportSource: null,
            sessionReplayEnabled: false,
            sessionReplayMaxSeedChars: 1000,
            sessionReplayStrategy: 'summary_plus_recent',
            sessionReplaySummaryRunnerV1: null,
        },
        messageDisplayCommon: {
            sessionThinkingDisplayMode: 'inline',
            sessionThinkingInlineChrome: 'plain',
            sessionThinkingInlinePresentation: 'full',
            transcriptMessageTimestampDisplayMode: 'always',
            transcriptMessageSelectionEnabled: false,
            transcriptMessageSendToSessionEnabled: false,
            transcriptStreamingMarkdownRenderingEnabled: true,
            transcriptStreamingPartialOutputEnabled: true,
            transcriptStreamingSettleDelayMs: 0,
            transcriptStreamingSmoothingEnabled: true,
            workspacePath: null,
        },
        toolChromeCommon: {
            toolViewTimelineChromeMode: 'activity_feed',
            transcriptToolCallsCollapsedPreviewCount: 3,
            transcriptToolCallsGroupShowBackground: false,
            ...(overrides?.toolChromeCommon ?? {}),
        },
        toolRouteCommon: {
            messagesById: {},
            reducerState: createReducer(),
        },
    };
}

type StyleEntry = Record<string, unknown> | null | undefined | false | readonly StyleEntry[];

export function flattenStyleProp(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return (style as readonly StyleEntry[]).reduce<Record<string, unknown>>(
            (accumulator, entry) => ({ ...accumulator, ...flattenStyleProp(entry) }),
            {},
        );
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
