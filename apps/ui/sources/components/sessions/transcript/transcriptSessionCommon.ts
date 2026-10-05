import * as React from 'react';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { useCurrentProjectedAgentCapabilities } from '@/agents/hooks/useCurrentProjectedAgentCapabilities';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useSessionDebugInformationEnabled } from '@/sync/runtime/useSessionDebugInformationEnabled';
import type { Message } from "@happier-dev/session-core/messages";
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionTranscriptSource } from './source/SessionTranscriptSourceContext';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionForkSupportSource } from '@/sync/domains/sessionFork/forkUiSupport';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ToolViewDisplaySettings } from '@/components/tools/shell/views/toolViewDisplaySettings';
import type { ReducerState } from "@happier-dev/session-core/reducer";
import {
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
    | 'transcriptMessageCopyActionEnabled'
    | 'transcriptMessageForkActionEnabled'
    | 'transcriptMessageRollbackActionEnabled'
    | 'transcriptMessagePinActionEnabled'
    | 'transcriptMessageSavePromptActionEnabled'
    | 'transcriptMessageMakeRepeatableActionEnabled'
    | 'transcriptMessagePluginActionsEnabled'
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
    | 'transcriptMessageCopyActionEnabled'
    | 'transcriptMessageForkActionEnabled'
    | 'transcriptMessageRollbackActionEnabled'
    | 'transcriptMessagePinActionEnabled'
    | 'transcriptMessageSavePromptActionEnabled'
    | 'transcriptMessageMakeRepeatableActionEnabled'
    | 'transcriptMessagePluginActionsEnabled'
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
    accountActorViewerScope?: ServerAccountScope | null;
    hasOtherNamedCollaborator?: boolean;
}>;

export type TranscriptForkCommon = Pick<TranscriptSessionCommonSettings,
    | 'sessionReplayEnabled'
    | 'sessionReplayMaxSeedChars'
    | 'sessionReplayStrategy'
    | 'sessionReplaySummaryRunnerV1'
> & Readonly<{
    executionRunsEnabled: boolean;
    /**
     * `sessions.agentSwitching` for THIS Session's server, resolved once for the
     * whole transcript rather than per row. Source-context continuation is
     * reachable from a message's fork launcher, so the row needs the same
     * decision the in-Session picker uses.
     */
    agentSwitchingEnabled: boolean;
    sessionForkSupportSource: SessionForkSupportSource | null;
    /** Exact current declaration used by all transcript fork affordances. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
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
> & Readonly<{
    /** Exact Home identity carried once by the mounted transcript host. */
    serverId?: string | null;
    /**
     * Tool display settings given as values instead of read from the store. Only surfaces that show
     * sample rows outside a session (settings previews) set it; the transcript host never does.
     */
    toolDisplaySettings?: ToolViewDisplaySettings;
}>;

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

export function useTranscriptSessionCommon(): TranscriptSessionCommon {
    const source = useSessionTranscriptSource();
    const sessionId = source.sessionId;
    const sessionServerId = source.serverId;
    // The exact Home identity the mounted transcript host resolved for this
    // Session. It is carried once per host (not re-resolved per row or per
    // callback) so every in-Session jump/link targets the same Home the
    // transcript is rendering. Absent only when the host itself has no Home
    // binding (legacy local state); no active-Home fallback is applied here.
    const exactSessionServerId = sessionServerId ?? null;
    // One exact-Home authorship owner, shared with the pending/discarded queue.
    const authorship = source.useAuthorship();
    const accountActorViewerScope = authorship.viewerScope;
    const sessionForkSupportSource = source.useForkSupportSource();
    const workspacePath = source.useWorkspacePath();
    const messagesById = source.useMessagesById();
    const reducerState = source.useReducerState();
    // The server the fork launchers spawn the child on, resolved through the one
    // owner they already use, so the decision below is scoped to that exact
    // server rather than to whatever the sidebar happens to have selected.
    const forkSpawnServerId = usePreferredServerIdForSession({
        serverId: sessionForkSupportSource?.serverId ?? sessionServerId,
        sessionId,
    }, source.kind === 'app');
    const executionRunsEnabled = useFeatureEnabled('execution.runs', forkSpawnServerId
        ? { scopeKind: 'spawn', serverId: forkSpawnServerId }
        : undefined);
    const forkOwnerMetadata = React.useMemo(
        () => sessionForkSupportSource ? readSessionOwnerMetadataView(sessionForkSupportSource) : null,
        [sessionForkSupportSource],
    );
    const forkAgentId = resolveAgentIdFromSessionMetadata(forkOwnerMetadata);
    const currentAgentCapabilities = useCurrentProjectedAgentCapabilities({
        agentId: forkAgentId,
        machineId: forkOwnerMetadata?.machineId ?? null,
        serverId: forkSpawnServerId,
        enabled: forkAgentId !== null,
    });
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: forkSpawnServerId,
    });
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
    const transcriptMessageCopyActionEnabled = useSetting('transcriptMessageCopyActionEnabled');
    const transcriptMessageForkActionEnabled = useSetting('transcriptMessageForkActionEnabled');
    const transcriptMessageRollbackActionEnabled = useSetting('transcriptMessageRollbackActionEnabled');
    const transcriptMessagePinActionEnabled = useSetting('transcriptMessagePinActionEnabled');
    const transcriptMessageSavePromptActionEnabled = useSetting('transcriptMessageSavePromptActionEnabled');
    const transcriptMessageMakeRepeatableActionEnabled = useSetting('transcriptMessageMakeRepeatableActionEnabled');
    const transcriptMessagePluginActionsEnabled = useSetting('transcriptMessagePluginActionsEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptStreamingMarkdownRenderingEnabled = useSetting('transcriptStreamingMarkdownRenderingEnabled');
    const transcriptStreamingPartialOutputEnabled = useSetting('transcriptStreamingPartialOutputEnabled');
    const transcriptStreamingSettleDelayMs = useSetting('transcriptStreamingSettleDelayMs');
    const transcriptStreamingSmoothingEnabled = useSetting('transcriptStreamingSmoothingEnabled');
    const transcriptToolCallsCollapsedPreviewCount = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const transcriptToolCallsGroupShowBackground = useSetting('transcriptToolCallsGroupShowBackground');

    const fork = React.useMemo<TranscriptForkCommon>(() => ({
        agentSwitchingEnabled,
        executionRunsEnabled,
        currentAgentCapabilities,
        sessionForkSupportSource,
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1,
    }), [
        agentSwitchingEnabled,
        executionRunsEnabled,
        currentAgentCapabilities,
        sessionForkSupportSource,
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1,
    ]);

    const messageDisplay = React.useMemo<TranscriptMessageDisplayCommon>(() => ({
        accountActorViewerScope,
        hasOtherNamedCollaborator: authorship.hasOtherNamedCollaborator,
        debugInformationEnabled,
        sessionThinkingDisplayMode,
        sessionThinkingInlineChrome,
        sessionThinkingInlinePresentation,
        transcriptMessageTimestampDisplayMode,
        transcriptMessageSelectionEnabled,
        transcriptMessageCopyActionEnabled,
        transcriptMessageForkActionEnabled,
        transcriptMessageRollbackActionEnabled,
        transcriptMessagePinActionEnabled,
        transcriptMessageSavePromptActionEnabled,
        transcriptMessageMakeRepeatableActionEnabled,
        transcriptMessagePluginActionsEnabled,
        transcriptMessageSendToSessionEnabled,
        transcriptStreamingMarkdownRenderingEnabled,
        transcriptStreamingPartialOutputEnabled,
        transcriptStreamingSettleDelayMs,
        transcriptStreamingSmoothingEnabled,
        workspacePath,
    }), [
        accountActorViewerScope,
        authorship.hasOtherNamedCollaborator,
        sessionThinkingDisplayMode,
        sessionThinkingInlineChrome,
        sessionThinkingInlinePresentation,
        transcriptMessageTimestampDisplayMode,
        transcriptMessageSelectionEnabled,
        transcriptMessageCopyActionEnabled,
        transcriptMessageForkActionEnabled,
        transcriptMessageRollbackActionEnabled,
        transcriptMessagePinActionEnabled,
        transcriptMessageSavePromptActionEnabled,
        transcriptMessageMakeRepeatableActionEnabled,
        transcriptMessagePluginActionsEnabled,
        transcriptMessageSendToSessionEnabled,
        transcriptStreamingMarkdownRenderingEnabled,
        transcriptStreamingPartialOutputEnabled,
        transcriptStreamingSettleDelayMs,
        transcriptStreamingSmoothingEnabled,
        debugInformationEnabled,
        workspacePath,
    ]);

    const toolChrome = React.useMemo<TranscriptToolChromeCommon>(() => ({
        serverId: exactSessionServerId,
        toolViewTimelineChromeMode,
        transcriptToolCallsCollapsedPreviewCount,
        transcriptToolCallsGroupShowBackground,
    }), [
        exactSessionServerId,
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
