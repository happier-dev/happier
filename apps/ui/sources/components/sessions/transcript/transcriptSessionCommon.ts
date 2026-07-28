import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionForkSupportSource } from '@/sync/domains/sessionFork/forkUiSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { ReducerState } from '@/sync/reducer/reducer';
import { isSessionDebugInformationEnabled } from '@/components/sessions/debug/sessionDebugInformation';
import {
    useLocalSetting,
    useSessionForkSupportSource,
    useSessionMessagesById,
    useSessionMessagesReducerState,
    useSessionWorkspacePath,
    useSetting,
} from '@/sync/domains/state/storage';

export type TranscriptSessionCommonSettings = Pick<Settings,
    | 'sessionReplayEnabled'
    | 'sessionReplayMaxSeedChars'
    | 'sessionReplayStrategy'
    | 'sessionReplaySummaryRunnerV1'
    | 'sessionThinkingDisplayMode'
    | 'sessionThinkingInlineChrome'
    | 'sessionThinkingInlinePresentation'
    | 'toolViewTimelineChromeMode'
    | 'transcriptMessageTimestampDisplayMode'
    | 'transcriptMessageSelectionEnabled'
    | 'transcriptMessageSendToSessionEnabled'
    | 'transcriptStreamingMarkdownRenderingEnabled'
    | 'transcriptStreamingPartialOutputEnabled'
    | 'transcriptStreamingSettleDelayMs'
    | 'transcriptStreamingSmoothingEnabled'
    | 'transcriptToolCallsCollapsedPreviewCount'
    | 'transcriptToolCallsGroupShowBackground'
>;

export type TranscriptMessageDisplayCommon = Pick<TranscriptSessionCommonSettings,
    | 'sessionThinkingDisplayMode'
    | 'sessionThinkingInlineChrome'
    | 'sessionThinkingInlinePresentation'
    | 'transcriptMessageTimestampDisplayMode'
    | 'transcriptMessageSelectionEnabled'
    | 'transcriptMessageSendToSessionEnabled'
    | 'transcriptStreamingMarkdownRenderingEnabled'
    | 'transcriptStreamingPartialOutputEnabled'
    | 'transcriptStreamingSettleDelayMs'
    | 'transcriptStreamingSmoothingEnabled'
> & Readonly<{
    workspacePath: string | null;
    /**
     * Resolved once per transcript rather than per row, so rendering a message does not add a
     * settings-store subscription for every row in the list.
     */
    debugInformationEnabled: boolean;
}>;

export type TranscriptForkCommon = Pick<TranscriptSessionCommonSettings,
    | 'sessionReplayEnabled'
    | 'sessionReplayMaxSeedChars'
    | 'sessionReplayStrategy'
    | 'sessionReplaySummaryRunnerV1'
> & Readonly<{
    executionRunsEnabled: boolean;
    sessionForkSupportSource: SessionForkSupportSource | null;
}>;

export type TranscriptToolChromeCommon = Pick<TranscriptSessionCommonSettings,
    | 'toolViewTimelineChromeMode'
    | 'transcriptToolCallsCollapsedPreviewCount'
    | 'transcriptToolCallsGroupShowBackground'
>;

export type TranscriptToolRouteCommon = Readonly<{
    messagesById: Readonly<Record<string, Message>>;
    reducerState: ReducerState | null;
}>;

export type TranscriptSessionCommon = Readonly<{
    fork: TranscriptForkCommon;
    messageDisplay: TranscriptMessageDisplayCommon;
    toolChrome: TranscriptToolChromeCommon;
    toolRoute: TranscriptToolRouteCommon;
}>;

export type TranscriptSessionCommonProps = Readonly<{
    forkCommon: TranscriptForkCommon;
    messageDisplayCommon: TranscriptMessageDisplayCommon;
    toolChromeCommon: TranscriptToolChromeCommon;
    toolRouteCommon: TranscriptToolRouteCommon;
}>;

export function hasTranscriptSessionCommonProps(
    props: Partial<TranscriptSessionCommonProps>,
): props is TranscriptSessionCommonProps {
    return props.forkCommon != null
        && props.messageDisplayCommon != null
        && props.toolChromeCommon != null
        && props.toolRouteCommon != null;
}

export function useTranscriptSessionCommon(sessionId: string): TranscriptSessionCommon {
    const sessionForkSupportSource = useSessionForkSupportSource(sessionId);
    const workspacePath = useSessionWorkspacePath(sessionId);
    const messagesById = useSessionMessagesById(sessionId);
    const reducerState = useSessionMessagesReducerState(sessionId);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    const debugInformationEnabled = isSessionDebugInformationEnabled(localDevModeEnabled);

    const sessionReplayEnabled = useSetting('sessionReplayEnabled');
    const sessionReplayMaxSeedChars = useSetting('sessionReplayMaxSeedChars');
    const sessionReplayStrategy = useSetting('sessionReplayStrategy');
    const sessionReplaySummaryRunnerV1 = useSetting('sessionReplaySummaryRunnerV1');
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const transcriptMessageTimestampDisplayMode = useSetting('transcriptMessageTimestampDisplayMode');
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptStreamingMarkdownRenderingEnabled = useSetting('transcriptStreamingMarkdownRenderingEnabled');
    const transcriptStreamingPartialOutputEnabled = useSetting('transcriptStreamingPartialOutputEnabled');
    const transcriptStreamingSettleDelayMs = useSetting('transcriptStreamingSettleDelayMs');
    const transcriptStreamingSmoothingEnabled = useSetting('transcriptStreamingSmoothingEnabled');
    const transcriptToolCallsCollapsedPreviewCount = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const transcriptToolCallsGroupShowBackground = useSetting('transcriptToolCallsGroupShowBackground');

    const fork = React.useMemo<TranscriptForkCommon>(() => ({
            executionRunsEnabled,
            sessionForkSupportSource,
            sessionReplayEnabled,
            sessionReplayMaxSeedChars,
            sessionReplayStrategy,
            sessionReplaySummaryRunnerV1,
        }), [
            executionRunsEnabled,
            sessionForkSupportSource,
            sessionReplayEnabled,
            sessionReplayMaxSeedChars,
            sessionReplayStrategy,
            sessionReplaySummaryRunnerV1,
        ]);

    const messageDisplay = React.useMemo<TranscriptMessageDisplayCommon>(() => ({
            debugInformationEnabled,
            sessionThinkingDisplayMode,
            sessionThinkingInlineChrome,
            sessionThinkingInlinePresentation,
            transcriptMessageTimestampDisplayMode,
            transcriptMessageSelectionEnabled,
            transcriptMessageSendToSessionEnabled,
            transcriptStreamingMarkdownRenderingEnabled,
            transcriptStreamingPartialOutputEnabled,
            transcriptStreamingSettleDelayMs,
            transcriptStreamingSmoothingEnabled,
            workspacePath,
        }), [
            debugInformationEnabled,
            sessionThinkingDisplayMode,
            sessionThinkingInlineChrome,
            sessionThinkingInlinePresentation,
            transcriptMessageTimestampDisplayMode,
            transcriptMessageSelectionEnabled,
            transcriptMessageSendToSessionEnabled,
            transcriptStreamingMarkdownRenderingEnabled,
            transcriptStreamingPartialOutputEnabled,
            transcriptStreamingSettleDelayMs,
            transcriptStreamingSmoothingEnabled,
            workspacePath,
        ]);

    const toolChrome = React.useMemo<TranscriptToolChromeCommon>(() => ({
            toolViewTimelineChromeMode,
            transcriptToolCallsCollapsedPreviewCount,
            transcriptToolCallsGroupShowBackground,
        }), [
            toolViewTimelineChromeMode,
            transcriptToolCallsCollapsedPreviewCount,
            transcriptToolCallsGroupShowBackground,
        ]);

    const toolRoute = React.useMemo<TranscriptToolRouteCommon>(() => ({
            messagesById,
            reducerState,
        }), [messagesById, reducerState]);

    return React.useMemo<TranscriptSessionCommon>(() => ({
        fork,
        messageDisplay,
        toolChrome,
        toolRoute,
    }), [fork, messageDisplay, toolChrome, toolRoute]);
}
