import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { Text } from '@/components/ui/text/Text';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { ToolTimelinePreviewRow } from '@/components/tools/shell/views/timeline/ToolTimelinePreviewRow';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';

export const ActivityGroupView = React.memo((props: {
    id: string;
    status: 'running' | 'completed' | 'error';
    toolMessages: ToolCallMessage[];
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
    interaction: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'readOnly' | 'notGranted';
    };
}) => {
    const { theme } = useUnistyles();
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const normalizedChromeMode = toolViewTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
    const transcriptTurnActivityGroupCollapsedPreviewCount = useSetting('transcriptTurnActivityGroupCollapsedPreviewCount');
    const expanded = props.expanded === true;
    const count = props.toolMessages.length;
    const createdAt = props.toolMessages[0]?.createdAt ?? Date.now();
    const collapsibleId = `activityGroup:${props.id}`;
    const previewCount = (() => {
        const raw = typeof transcriptTurnActivityGroupCollapsedPreviewCount === 'number'
            ? transcriptTurnActivityGroupCollapsedPreviewCount
            : 5;
        if (!Number.isFinite(raw)) return 5;
        return Math.max(0, Math.min(15, Math.trunc(raw)));
    })();
    const previewMessages = !expanded && previewCount > 0 ? props.toolMessages.slice(-previewCount) : [];
    const hiddenCount = !expanded && previewCount > 0 ? Math.max(0, count - previewMessages.length) : 0;

    return (
        <View style={[styles.container, normalizedChromeMode === 'activity_feed' ? styles.containerFeed : styles.containerCards]}>
            <Pressable
                testID="transcript-activity-header"
                onPress={() => props.setExpanded(!expanded)}
                style={({ pressed }) => [
                    styles.header,
                    normalizedChromeMode === 'activity_feed' ? styles.headerFeed : styles.headerCards,
                    pressed && (normalizedChromeMode === 'activity_feed' ? styles.headerFeedPressed : styles.headerCardsPressed),
                ]}
            >
                <View style={styles.statusIcon}>
                    {props.status === 'running' ? (
                        <ActivityIndicator size="small" />
                    ) : props.status === 'error' ? (
                        <Ionicons name="alert-circle" size={16} color={theme.colors.textDestructive} />
                    ) : (
                        <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                    )}
                </View>
                <Text style={styles.title}>
                    {t('session.activity')}
                    <Text style={styles.subtitle}> · {count}</Text>
                </Text>
                <View style={styles.chevron}>
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </View>
            </Pressable>
            {previewMessages.length > 0 ? (
                <View style={[styles.preview, normalizedChromeMode === 'activity_feed' ? styles.previewFeed : styles.previewCards]}>
                    {previewMessages.map((m) => (
                        <View
                            key={`preview:${m.id}`}
                            testID="transcript-activity-preview-row"
                            style={[styles.previewRow, normalizedChromeMode === 'activity_feed' ? styles.previewRowFeed : styles.previewRowCards]}
                        >
                            <ToolTimelinePreviewRow
                                toolMessage={m}
                                metadata={props.metadata}
                                onPress={() => props.setExpanded(true)}
                            />
                        </View>
                    ))}
                    {hiddenCount > 0 ? (
                        <Pressable
                            testID="transcript-activity-preview-more"
                            onPress={() => props.setExpanded(true)}
                            style={({ pressed }) => [styles.previewMore, pressed && styles.previewMorePressed]}
                        >
                            <Text style={styles.previewMoreText}>
                                {t('session.activityCollapsedPreviewMore', { count: hiddenCount })}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            <TranscriptCollapsible id={collapsibleId} createdAt={createdAt} expanded={expanded}>
                <View style={[styles.body, normalizedChromeMode === 'activity_feed' ? styles.bodyFeed : styles.bodyCards]}>
                    {props.toolMessages.map((m) => (
                        <TranscriptEnterWrapper key={m.id} id={m.id} createdAt={m.createdAt}>
                            <View
                                testID="transcript-activity-tool-row"
                                style={[styles.toolRow, normalizedChromeMode === 'activity_feed' ? styles.toolRowFeed : styles.toolRowCards]}
                            >
                                {normalizedChromeMode === 'activity_feed' ? (
                                    <ToolTimelineRow
                                        tool={m.tool}
                                        metadata={props.metadata}
                                        messages={m.children}
                                        sessionId={props.sessionId}
                                        messageId={m.id}
                                        interaction={props.interaction}
                                    />
                                ) : (
                                    <ToolView
                                        tool={m.tool}
                                        metadata={props.metadata}
                                        messages={m.children}
                                        sessionId={props.sessionId}
                                        messageId={m.id}
                                        interaction={props.interaction}
                                    />
                                )}
                            </View>
                        </TranscriptEnterWrapper>
                    ))}
                </View>
            </TranscriptCollapsible>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginTop: 4,
        marginBottom: 12,
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
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 8,
    },
    headerCards: {},
    headerCardsPressed: {
        opacity: 0.92,
    },
    headerFeed: {
        borderRadius: 12,
    },
    headerFeedPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    statusIcon: {
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
        fontWeight: '500',
    },
    chevron: {
        width: 18,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    preview: {
        paddingBottom: 6,
    },
    previewCards: {
        paddingHorizontal: 6,
    },
    previewFeed: {
        paddingHorizontal: 0,
    },
    previewRow: {
    },
    previewRowCards: {
        marginHorizontal: 2,
    },
    previewRowFeed: {
        marginHorizontal: 0,
    },
    previewMore: {
        paddingHorizontal: 10,
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
        marginHorizontal: 4,
        marginBottom: 6,
    },
    toolRowFeed: {
        marginHorizontal: 0,
        marginBottom: 0,
    },
}));
