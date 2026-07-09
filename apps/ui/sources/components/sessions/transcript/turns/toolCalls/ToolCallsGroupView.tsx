import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as FlashListCompat from '@/components/ui/lists/flashListCompat/FlashListCompat';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import {
    useTranscriptSessionCommon,
    type TranscriptForkCommon,
    type TranscriptMessageDisplayCommon,
    type TranscriptToolChromeCommon,
    type TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import { TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import {
    renderGroupedToolCallRowContent,
    resolveGroupedPreviewSidechainIds,
} from '@/components/sessions/transcript/toolCalls/units/groupedToolCallRowContent';
import { ToolCallPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import {
    ToolCallsGroupExpandMoreChrome,
    ToolCallsGroupHeaderChrome,
} from '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome';

const fallbackMappingHelper = {
    getMappingKey: (itemKey: string | number | bigint) => itemKey,
};

function useFallbackMappingHelper() {
    return fallbackMappingHelper;
}

function resolveToolCallsGroupMappingHelper() {
    try {
        return typeof FlashListCompat.useMappingHelper === 'function'
            ? FlashListCompat.useMappingHelper
            : useFallbackMappingHelper;
    } catch {
        return useFallbackMappingHelper;
    }
}

const useToolCallsGroupMappingHelper = resolveToolCallsGroupMappingHelper();

type ToolCallsGroupViewProps = Readonly<{
    id: string;
    status: 'running' | 'completed' | 'error';
    toolMessages: ToolCallMessage[];
    metadata: Metadata | null;
    sessionId: string;
    forcePermissionPromptsInTranscript?: boolean;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleToolPin?: (pin: PersistedSessionMessagePinV1) => void;
    interaction: TranscriptInteraction;
}>;

type ToolCallsGroupViewWithSessionCommonProps = ToolCallsGroupViewProps & Readonly<{
    forkCommon: TranscriptForkCommon;
    messageDisplayCommon: TranscriptMessageDisplayCommon;
    toolChromeCommon: TranscriptToolChromeCommon;
    toolRouteCommon: TranscriptToolRouteCommon;
}>;

export const ToolCallsGroupView = React.memo((props: ToolCallsGroupViewProps) => {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const forkCommon = React.useMemo(() => transcriptSessionCommon.fork, [
        transcriptSessionCommon.fork.executionRunsEnabled,
        transcriptSessionCommon.fork.sessionForkSupportSource,
        transcriptSessionCommon.fork.sessionReplayEnabled,
        transcriptSessionCommon.fork.sessionReplayMaxSeedChars,
        transcriptSessionCommon.fork.sessionReplayStrategy,
        transcriptSessionCommon.fork.sessionReplaySummaryRunnerV1,
    ]);
    const messageDisplayCommon = React.useMemo(() => transcriptSessionCommon.messageDisplay, [
        transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode,
        transcriptSessionCommon.messageDisplay.sessionThinkingInlineChrome,
        transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation,
        transcriptSessionCommon.messageDisplay.transcriptMessageTimestampDisplayMode,
        transcriptSessionCommon.messageDisplay.transcriptStreamingMarkdownRenderingEnabled,
        transcriptSessionCommon.messageDisplay.transcriptStreamingPartialOutputEnabled,
        transcriptSessionCommon.messageDisplay.transcriptStreamingSettleDelayMs,
        transcriptSessionCommon.messageDisplay.transcriptStreamingSmoothingEnabled,
        transcriptSessionCommon.messageDisplay.workspacePath,
    ]);
    const toolChromeCommon = React.useMemo(() => transcriptSessionCommon.toolChrome, [
        transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode,
        transcriptSessionCommon.toolChrome.transcriptToolCallsCollapsedPreviewCount,
        transcriptSessionCommon.toolChrome.transcriptToolCallsGroupShowBackground,
    ]);
    const toolRouteCommon = React.useMemo(() => transcriptSessionCommon.toolRoute, [
        transcriptSessionCommon.toolRoute.messagesById,
        transcriptSessionCommon.toolRoute.reducerState,
    ]);

    return (
        <ToolCallsGroupViewWithSessionCommon
            {...props}
            forkCommon={forkCommon}
            messageDisplayCommon={messageDisplayCommon}
            toolChromeCommon={toolChromeCommon}
            toolRouteCommon={toolRouteCommon}
        />
    );
});

export const ToolCallsGroupViewWithSessionCommon = React.memo((props: ToolCallsGroupViewWithSessionCommonProps) => {
    const { theme } = useUnistyles();
    const { getMappingKey } = useToolCallsGroupMappingHelper();
    const {
        toolViewTimelineChromeMode,
        transcriptToolCallsCollapsedPreviewCount,
        transcriptToolCallsGroupShowBackground,
    } = props.toolChromeCommon;
    const normalizedChromeMode = toolViewTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
    const { messagesById, reducerState } = props.toolRouteCommon;
    const expanded = props.expanded === true;
    const count = props.toolMessages.length;
    const createdAt = props.toolMessages[0]?.createdAt ?? Date.now();
    const collapsibleId = `toolCallsGroup:${props.id}`;
    const showFeedBackground = normalizedChromeMode === 'activity_feed' && transcriptToolCallsGroupShowBackground === true;
    const feedBackgroundStyle = showFeedBackground
        ? {
            borderRadius: 14,
            backgroundColor: theme.colors.feed?.card?.background ?? theme.colors.surface.elevated,
            overflow: 'hidden' as const,
            paddingHorizontal: 10,
            paddingVertical: 6,
        }
        : null;
    const previewCount = resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCount);
    const previewMessages = React.useMemo(() => {
        if (expanded || previewCount <= 0) return [];
        return props.toolMessages.slice(-previewCount);
    }, [expanded, previewCount, props.toolMessages]);

    const hiddenCount = expanded ? 0 : Math.max(0, count - previewMessages.length);
    const showExpandButton = !expanded && hiddenCount > 0;
    const showCollapsedPreview = previewMessages.length > 0;
    const { setExpanded } = props;
    const onCollapse = React.useCallback(() => setExpanded(false), [setExpanded]);
    const onExpand = React.useCallback(() => setExpanded(true), [setExpanded]);
    const previewSidechainIds = React.useMemo(() => {
        return resolveGroupedPreviewSidechainIds({
            chromeMode: normalizedChromeMode,
            previewMessages,
        });
    }, [normalizedChromeMode, previewMessages]);

    useEnsureSidechainsLoaded({
        enabled: !expanded && previewSidechainIds.length > 0 && props.interaction.disableToolNavigation !== true,
        sessionId: props.sessionId,
        sidechainIds: previewSidechainIds,
    });

    const resolveToolRouteMessageId = React.useCallback((message: ToolCallMessage) => {
        if (props.interaction.disableToolNavigation) return undefined;
        return resolveMessageRouteIdForDisplay({
            message,
            messagesById,
            reducerState,
        });
    }, [messagesById, props.interaction.disableToolNavigation, reducerState]);
    const renderToolPinAction = React.useCallback((message: ToolCallMessage, nestedMessageId: string | undefined) => {
        if (!props.onToggleToolPin) return null;
        const toolPinAvailability = resolveMessagePinAvailability({
            sessionId: props.sessionId,
            seq: message.seq ?? null,
            transcriptBlockIndex: message.transcriptBlockIndex ?? null,
            routeMessageId: nestedMessageId ?? null,
            role: 'tool',
            pins: props.messagePins ?? [],
            readOnlyContext: props.interaction.permissionDisabledReason === 'readOnly',
        });
        if (toolPinAvailability.status !== 'available') return null;
        return (
            <ToolCallPinAction
                availability={toolPinAvailability}
                onTogglePin={props.onToggleToolPin}
                testID={`transcript-tool-call-pin:${message.id}`}
            />
        );
    }, [props.interaction.permissionDisabledReason, props.messagePins, props.onToggleToolPin, props.sessionId]);

    return (
        <View
            testID="transcript-tool-calls-group"
            style={[
                styles.container,
                normalizedChromeMode === 'activity_feed'
                    ? (showFeedBackground ? feedBackgroundStyle : styles.containerFeed)
                    : styles.containerCards,
            ]}
        >
            <ToolCallsGroupHeaderChrome
                chromeMode={normalizedChromeMode}
                status={props.status}
                count={count}
                expanded={expanded}
                onCollapse={onCollapse}
            />

            <View style={[styles.contentRow, normalizedChromeMode === 'activity_feed' ? styles.contentRowFeed : styles.contentRowCards]}>
                <View style={styles.contentGutter}>
                    <View style={styles.gutterLine} />
                </View>
                <View style={styles.contentBody}>
                    {showExpandButton || showCollapsedPreview ? (
                        <View style={[styles.preview, normalizedChromeMode === 'activity_feed' ? styles.previewFeed : styles.previewCards]}>
                            {showExpandButton ? (
                                <ToolCallsGroupExpandMoreChrome hiddenCount={hiddenCount} onExpand={onExpand} />
                            ) : null}
                            {showCollapsedPreview ? previewMessages.map((m, index) => {
                                const nestedMessageId = resolveToolRouteMessageId(m);
                                const toolPinAction = renderToolPinAction(m, nestedMessageId);
                                return (
                                <View
                                    key={getMappingKey(`preview:${m.id}`, index)}
                                    testID={`${TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX}${m.id}`}
                                >
                                    <View
                                        testID="transcript-tool-calls-preview-row"
                                        style={[styles.previewRow, normalizedChromeMode === 'activity_feed' ? styles.previewRowFeed : styles.previewRowCards]}
                                    >
                                        {renderGroupedToolCallRowContent({
                                            message: m,
                                            chromeMode: normalizedChromeMode,
                                            groupExpanded: false,
                                            metadata: props.metadata,
                                            sessionId: props.sessionId,
                                            nestedMessageId,
                                            forcePermissionPromptsInTranscript: props.forcePermissionPromptsInTranscript,
                                            approvalRequests: props.approvalRequests,
                                            messagePins: props.messagePins,
                                            onToggleToolPin: props.onToggleToolPin,
                                            toolPinAction,
                                            interaction: props.interaction,
                                            forkCommon: props.forkCommon,
                                            messageDisplayCommon: props.messageDisplayCommon,
                                            toolChromeCommon: props.toolChromeCommon,
                                            toolRouteCommon: props.toolRouteCommon,
                                        })}
                                    </View>
                                </View>
                                );
                            }) : null}
                        </View>
                    ) : null}

                    {expanded ? (
                        <TranscriptCollapsible id={collapsibleId} createdAt={createdAt} expanded={expanded}>
                            <View style={[styles.body, normalizedChromeMode === 'activity_feed' ? styles.bodyFeed : styles.bodyCards]}>
                                {props.toolMessages.map((m, index) => {
                                    const nestedMessageId = resolveToolRouteMessageId(m);
                                    const toolPinAction = renderToolPinAction(m, nestedMessageId);
                                    return (
                                    <TranscriptEnterWrapper key={getMappingKey(m.id, index)} id={m.id} createdAt={m.createdAt}>
                                        <View
                                            testID={`${TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX}${m.id}`}
                                        >
                                            <View
                                                testID="transcript-tool-calls-tool-row"
                                                style={[styles.toolRow, normalizedChromeMode === 'activity_feed' ? styles.toolRowFeed : styles.toolRowCards]}
                                            >
                                                {renderGroupedToolCallRowContent({
                                                    message: m,
                                                    chromeMode: normalizedChromeMode,
                                                    groupExpanded: expanded,
                                                    metadata: props.metadata,
                                                    sessionId: props.sessionId,
                                                    nestedMessageId,
                                                    forcePermissionPromptsInTranscript: props.forcePermissionPromptsInTranscript,
                                                    approvalRequests: props.approvalRequests,
                                                    messagePins: props.messagePins,
                                                    onToggleToolPin: props.onToggleToolPin,
                                                    toolPinAction,
                                                    interaction: props.interaction,
                                                    forkCommon: props.forkCommon,
                                                    messageDisplayCommon: props.messageDisplayCommon,
                                                    toolChromeCommon: props.toolChromeCommon,
                                                    toolRouteCommon: props.toolRouteCommon,
                                                })}
                                            </View>
                                        </View>
                                    </TranscriptEnterWrapper>
                                    );
                                })}
                            </View>
                        </TranscriptCollapsible>
                    ) : null}
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginBottom: 22,
    },
    containerCards: {
        borderRadius: 14,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
        overflow: 'hidden',
    },
    containerFeed: {
        borderRadius: 0,
        backgroundColor: 'transparent',
        overflow: 'visible',
    },
    contentRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    contentRowFeed: {},
    contentRowCards: {
        paddingBottom: 6,
    },
    contentGutter: {
        width: 18,
        alignItems: 'center',
    },
    gutterLine: {
        flex: 1,
        width: 2,
        borderRadius: 2,
        backgroundColor: theme.colors.message.event.foreground,
        opacity: 0.1,
        marginBottom: 7
    },
    contentBody: {
        flex: 1,
        minWidth: 0,
        paddingLeft: 6,
    },
    preview: {
        paddingBottom: 6,
    },
    previewCards: {
        paddingHorizontal: 0,
    },
    previewFeed: {
        paddingHorizontal: 0,
    },
    previewRow: {
    },
    previewRowCards: {
        marginHorizontal: 0,
    },
    previewRowFeed: {
        marginHorizontal: 0,
    },
    body: {
        paddingBottom: 6,
    },
    bodyCards: {},
    bodyFeed: {},
    toolRow: {
    },
    toolRowCards: {
        marginHorizontal: 0,
        marginBottom: 0,
    },
    toolRowFeed: {
        marginHorizontal: 0,
        marginBottom: 0,
    },
}));
