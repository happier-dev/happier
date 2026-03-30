import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { Text } from '@/components/ui/text/Text';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { MessageView } from '@/components/sessions/transcript/MessageView';
import { t } from '@/text';
import { useSessionMessagesById, useSessionMessagesReducerState, useSetting } from '@/sync/domains/state/storage';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';

function shouldRenderGroupedToolCallWithMessageView(
    message: ToolCallMessage,
    chromeMode: 'activity_feed' | 'cards',
    groupExpanded: boolean,
): boolean {
    if (chromeMode === 'cards') {
        return true;
    }
    const hasStructuredMeta = Boolean(message.meta?.happier);
    if (hasStructuredMeta) return true;

    // Avoid switching the renderer for subagent tool calls based on streaming children.
    // Otherwise the row remounts (ToolTimelineRow → MessageView) and the user's expanded/collapsed state resets.
    if (isSubAgentTranscriptToolName(message.tool?.name ?? '')) {
        return groupExpanded;
    }

    return false;
}

export function resolveGroupedPreviewSidechainIds(params: Readonly<{
    chromeMode: 'activity_feed' | 'cards';
    previewMessages: readonly ToolCallMessage[];
}>): readonly string[] {
    if (params.chromeMode !== 'activity_feed') {
        return [];
    }

    const sidechainIds = new Set<string>();
    for (const message of params.previewMessages) {
        const toolName = typeof message.tool?.name === 'string' ? message.tool.name : '';
        if (!isSubAgentTranscriptToolName(toolName)) continue;
        const sidechainId = resolveToolTranscriptSidechainId({
            tool: message.tool,
            normalizedToolName: toolName,
        });
        if (!sidechainId) continue;
        sidechainIds.add(sidechainId);
    }
    return [...sidechainIds];
}

function renderGroupedToolCallRowContent(params: Readonly<{
    message: ToolCallMessage;
    chromeMode: 'activity_feed' | 'cards';
    groupExpanded: boolean;
    metadata: Metadata | null;
    sessionId: string;
    nestedMessageId: string | undefined;
    forcePermissionPromptsInTranscript?: boolean;
    interaction: TranscriptInteraction;
}>): React.ReactNode {
    if (shouldRenderGroupedToolCallWithMessageView(params.message, params.chromeMode, params.groupExpanded)) {
        return (
            <MessageView
                message={params.message}
                metadata={params.metadata}
                sessionId={params.sessionId}
                layoutContext="tool_calls_group"
                forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
                interaction={params.interaction}
            />
        );
    }

    if (params.chromeMode === 'activity_feed') {
        return (
            <ToolTimelineRow
                tool={params.message.tool}
                metadata={params.metadata}
                messages={params.message.children}
                sessionId={params.sessionId}
                messageId={params.nestedMessageId}
                forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
                interaction={params.interaction}
            />
        );
    }

    return (
        <ToolView
            tool={params.message.tool}
            metadata={params.metadata}
            messages={params.message.children}
            sessionId={params.sessionId}
            messageId={params.nestedMessageId}
            forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
            interaction={params.interaction}
        />
    );
}

export const ToolCallsGroupView = React.memo((props: {
    id: string;
    status: 'running' | 'completed' | 'error';
    toolMessages: ToolCallMessage[];
    metadata: Metadata | null;
    sessionId: string;
    forcePermissionPromptsInTranscript?: boolean;
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
    interaction: TranscriptInteraction;
}) => {
    const { theme } = useUnistyles();
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const normalizedChromeMode = toolViewTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
    const transcriptToolCallsGroupShowBackground = useSetting('transcriptToolCallsGroupShowBackground');
    const transcriptToolCallsCollapsedPreviewCount = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const messagesById = useSessionMessagesById(props.sessionId);
    const reducerState = useSessionMessagesReducerState(props.sessionId);
    const expanded = props.expanded === true;
    const count = props.toolMessages.length;
    const createdAt = props.toolMessages[0]?.createdAt ?? Date.now();
    const collapsibleId = `toolCallsGroup:${props.id}`;
    const showFeedBackground = normalizedChromeMode === 'activity_feed' && transcriptToolCallsGroupShowBackground === true;
    const feedBackgroundStyle = showFeedBackground
        ? {
            borderRadius: 14,
            backgroundColor: theme.colors.input.background,
            overflow: 'hidden' as const,
            paddingHorizontal: 10,
            paddingVertical: 6,
        }
        : null;
    const previewCount = (() => {
        const raw = typeof transcriptToolCallsCollapsedPreviewCount === 'number'
            ? transcriptToolCallsCollapsedPreviewCount
            : 5;
        if (!Number.isFinite(raw)) return 5;
        return Math.max(0, Math.min(15, Math.trunc(raw)));
    })();
    const latestToolMessageId = props.toolMessages[count - 1]?.id ?? null;
    const collapsedPreviewAnchorIdRef = React.useRef<string | null>(null);
    const prevExpandedRef = React.useRef<boolean>(expanded);
    React.useEffect(() => {
        const prevExpanded = prevExpandedRef.current;
        prevExpandedRef.current = expanded;
        if (expanded) {
            collapsedPreviewAnchorIdRef.current = null;
            return;
        }
        // Freeze the preview window when a group is collapsed so streaming tool messages don't cause
        // previously-visible tool rows to disappear (which is jarring while the user is reading).
        if (collapsedPreviewAnchorIdRef.current == null || prevExpanded) {
            collapsedPreviewAnchorIdRef.current = latestToolMessageId;
        }
    }, [expanded, latestToolMessageId]);

    const previewMessages = React.useMemo(() => {
        if (expanded || previewCount <= 0 || count === 0) return [];
        const anchorId = collapsedPreviewAnchorIdRef.current;
        const anchorIndex = anchorId ? props.toolMessages.findIndex((m) => m.id === anchorId) : -1;
        const anchoredMessages =
            anchorIndex >= 0
                ? props.toolMessages.slice(0, anchorIndex + 1)
                : props.toolMessages;
        return anchoredMessages.slice(-previewCount);
    }, [count, expanded, previewCount, props.toolMessages]);

    const hiddenCount = !expanded && previewCount > 0 ? Math.max(0, count - previewMessages.length) : 0;
    const previewSidechainIds = React.useMemo(() => {
        return resolveGroupedPreviewSidechainIds({
            chromeMode: normalizedChromeMode,
            previewMessages,
        });
    }, [normalizedChromeMode, previewMessages]);

    useEnsureSidechainsLoaded({
        enabled: !expanded && previewSidechainIds.length > 0,
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
            <Pressable
                testID="transcript-tool-calls-header"
                onPress={() => props.setExpanded(!expanded)}
                style={({ pressed }) => [
                    styles.header,
                    pressed && (normalizedChromeMode === 'activity_feed' ? styles.headerFeedPressed : styles.headerCardsPressed),
                ]}
            >
                <View style={styles.headerGutter}>
                    <Ionicons name="layers-outline" size={16} color={theme.colors.textSecondary} />
                </View>
                <Text style={styles.title}>
                    {t('session.toolCalls')}
                    <Text style={styles.subtitle}> · {count}</Text>
                </Text>
                <View style={styles.headerRight}>
                    <View style={styles.statusIconRight}>
                        {props.status === 'running' ? (
                            <ActivityIndicator size="small" />
                        ) : props.status === 'error' ? (
                            <Ionicons name="alert-circle" size={16} color={theme.colors.textDestructive} />
                        ) : (
                            <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                        )}
                    </View>
                    <Ionicons
                        name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </View>
            </Pressable>

            <View style={[styles.contentRow, normalizedChromeMode === 'activity_feed' ? styles.contentRowFeed : styles.contentRowCards]}>
                <View style={styles.contentGutter}>
                    <View style={styles.gutterLine} />
                </View>
                <View style={styles.contentBody}>
                    {previewMessages.length > 0 ? (
                        <View style={[styles.preview, normalizedChromeMode === 'activity_feed' ? styles.previewFeed : styles.previewCards]}>
                            {hiddenCount > 0 ? (
                                <Pressable
                                    testID="transcript-tool-calls-preview-more"
                                    onPress={() => props.setExpanded(true)}
                                    style={({ pressed }) => [styles.previewMore, pressed && styles.previewMorePressed]}
                                >
                                    <Text style={styles.previewMoreText}>
                                        {t('session.toolCallsCollapsedPreviewMore', { count: hiddenCount })}
                                    </Text>
                                </Pressable>
                            ) : null}
                            {previewMessages.map((m) => {
                                const nestedMessageId = resolveToolRouteMessageId(m);
                                return (
                                <View
                                    key={`preview:${m.id}`}
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
                                        interaction: props.interaction,
                                    })}
                                </View>
                                );
                            })}
                        </View>
                    ) : null}

                    <TranscriptCollapsible id={collapsibleId} createdAt={createdAt} expanded={expanded}>
                        <View style={[styles.body, normalizedChromeMode === 'activity_feed' ? styles.bodyFeed : styles.bodyCards]}>
                            {props.toolMessages.map((m) => {
                                const nestedMessageId = resolveToolRouteMessageId(m);
                                return (
                                <TranscriptEnterWrapper key={m.id} id={m.id} createdAt={m.createdAt}>
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
                                            interaction: props.interaction,
                                        })}
                                    </View>
                                </TranscriptEnterWrapper>
                                );
                            })}
                        </View>
                    </TranscriptCollapsible>
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
        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
        overflow: 'hidden',
    },
    containerFeed: {
        borderRadius: 0,
        backgroundColor: 'transparent',
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 6,
        gap: 8,
    },
    headerCardsPressed: {
        opacity: 0.92,
    },
    headerFeedPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    headerGutter: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        flexGrow: 1,
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    subtitle: {
        color: theme.colors.agentEventText,
        fontSize: 13,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    statusIconRight: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
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
        backgroundColor: theme.colors.agentEventText,
        opacity: 0.42,
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
    previewMore: {
        paddingHorizontal: 0,
        paddingTop: 6,
        paddingBottom: 2,
        alignSelf: 'flex-start',
    },
    previewMorePressed: {
        opacity: 0.9,
    },
    previewMoreText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
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
        marginBottom: 6,
    },
    toolRowFeed: {
        marginHorizontal: 0,
        marginBottom: 0,
    },
}));
