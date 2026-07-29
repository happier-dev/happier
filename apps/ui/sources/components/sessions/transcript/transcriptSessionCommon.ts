import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionDebugInformationEnabled } from '@/sync/runtime/useSessionDebugInformationEnabled';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionForkSupportSource } from '@/sync/domains/sessionFork/forkUiSupport';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ReducerState } from '@/sync/reducer/reducer';
import {
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
     * Carried as a prop so the transcript list resolves it once for every row it hoists common
     * props to. Rows that fall back to the standalone `MessageView` wrapper resolve this hook set
     * themselves, as they already do for every other setting here.
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

export function deriveTranscriptForkCommonForInteraction(
    forkCommon: TranscriptForkCommon,
    interaction: TranscriptInteraction | null | undefined,
): TranscriptForkCommon {
    if (interaction?.canFork === true || forkCommon.sessionForkSupportSource == null) return forkCommon;
    return { ...forkCommon, sessionForkSupportSource: null };
}

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
    const debugInformationEnabled = useSessionDebugInformationEnabled();

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
        debugInformationEnabled,
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
