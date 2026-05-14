import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { sessionAbort } from '@/sync/ops';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { PendingMessagesDragReorderList } from './PendingMessagesDragReorderList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

function getPendingText(message: PendingMessage | DiscardedPendingMessage): string {
    const raw = (message.displayText ?? message.text) ?? '';
    return String(raw);
}

function canSteerNowForSession(session: ReturnType<typeof useSession>): boolean {
    const capabilities = session?.agentState?.capabilities;
    return Boolean(
        session?.thinking
        && session?.presence === 'online'
        && (session?.agentStateVersion ?? 0) > 0
        && session?.agentState?.controlledByUser !== true
        && (capabilities?.inFlightSteerAvailable ?? capabilities?.inFlightSteer) === true
    );
}

function supportsInFlightSteerForSession(session: ReturnType<typeof useSession>): boolean {
    const capabilities = session?.agentState?.capabilities;
    return Boolean(
        session?.presence === 'online'
        && (session?.agentStateVersion ?? 0) > 0
        && session?.agentState?.controlledByUser !== true
        && (capabilities?.inFlightSteerSupported ?? capabilities?.inFlightSteer) === true
    );
}

export function PendingMessagesTranscriptBlock(props: Readonly<{
    sessionId: string;
    pendingMessages: PendingMessage[];
    discardedMessages: DiscardedPendingMessage[];
}>) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);

    const canSteerNow = canSteerNowForSession(session);
    const supportsInFlightSteer = supportsInFlightSteerForSession(session);
    const pendingCount = props.pendingMessages.length;
    const discardedCount = props.discardedMessages.length;
    const showNonSteerableNotice = Boolean(
        pendingCount > 0
        && session?.thinking
        && supportsInFlightSteer
        && !canSteerNow
    );

    const maxHeightSetting = useSetting('transcriptPendingQueueMaxHeightPx');
    const maxHeightPx =
        typeof maxHeightSetting === 'number' && Number.isFinite(maxHeightSetting)
            ? Math.max(1, Math.trunc(maxHeightSetting))
            : settingsDefaults.transcriptPendingQueueMaxHeightPx;

    const expandedMaxHeightSetting = useSetting('transcriptPendingQueueExpandedMaxHeightPx');
    const expandedMaxHeightPx =
        typeof expandedMaxHeightSetting === 'number' && Number.isFinite(expandedMaxHeightSetting)
            ? Math.max(maxHeightPx, Math.trunc(expandedMaxHeightSetting))
            : Math.max(maxHeightPx, settingsDefaults.transcriptPendingQueueExpandedMaxHeightPx);

    const collapseThresholdCharsSetting = useSetting('transcriptPendingMessageCollapseThresholdChars');
    const collapseThresholdChars =
        typeof collapseThresholdCharsSetting === 'number' && Number.isFinite(collapseThresholdCharsSetting)
            ? Math.max(0, Math.trunc(collapseThresholdCharsSetting))
            : settingsDefaults.transcriptPendingMessageCollapseThresholdChars;

    const collapsedLinesSetting = useSetting('transcriptPendingMessageCollapsedLines');
    const collapsedLines =
        typeof collapsedLinesSetting === 'number' && Number.isFinite(collapsedLinesSetting)
            ? Math.max(1, Math.trunc(collapsedLinesSetting))
            : settingsDefaults.transcriptPendingMessageCollapsedLines;

    const reorderRowHeightSetting = useSetting('transcriptPendingQueueReorderRowHeightPx');
    const reorderEstimatedRowHeightPx =
        typeof reorderRowHeightSetting === 'number' && Number.isFinite(reorderRowHeightSetting)
            ? Math.max(24, Math.trunc(reorderRowHeightSetting))
            : settingsDefaults.transcriptPendingQueueReorderRowHeightPx;

    const [expandedMessageIds, setExpandedMessageIds] = React.useState<Record<string, true>>({});
    const [isPendingQueueExpanded, setIsPendingQueueExpanded] = React.useState(false);
    const [openMenuKey, setOpenMenuKey] = React.useState<string | null>(null);
    const [scrollContentHeightPx, setScrollContentHeightPx] = React.useState<number | null>(null);
    const isWeb = Platform.OS === 'web';
    const [hoveredMessageId, setHoveredMessageId] = React.useState<string | null>(null);
    const [scrollViewportHeightPx, setScrollViewportHeightPx] = React.useState<number | null>(null);
    const [scrollOffsetY, setScrollOffsetY] = React.useState<number | null>(null);
    const scrollRef = React.useRef<ScrollView | null>(null);

    React.useEffect(() => {
        if (props.pendingMessages.length <= 0) {
            setIsPendingQueueExpanded(false);
        }
    }, [props.pendingMessages.length]);

    const pendingIndexById = React.useMemo(() => {
        const map: Record<string, number> = {};
        props.pendingMessages.forEach((m, i) => {
            map[m.id] = i;
        });
        return map;
    }, [props.pendingMessages]);

    const toggleMessageExpanded = React.useCallback((id: string) => {
        setExpandedMessageIds((prev) => {
            const next = { ...prev };
            if (next[id]) {
                delete next[id];
            } else {
                next[id] = true;
            }
            return next;
        });
    }, []);

    const togglePendingQueueExpanded = React.useCallback(() => {
        setIsPendingQueueExpanded((value) => !value);
    }, []);

    const handleEdit = React.useCallback(async (pendingId: string, currentText: string) => {
        const next = await Modal.prompt(
            t('session.pendingMessages.editPrompt.title'),
            undefined,
            { defaultValue: currentText, confirmText: t('common.save') },
        );
        if (next === null) return;
        if (!next.trim()) return;
        try {
            await sync.updatePendingMessage(props.sessionId, pendingId, next);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.updateFailed'));
        }
    }, [props.sessionId]);

    const handleReorderIds = React.useCallback(async (ids: string[]) => {
        if (ids.length <= 1) return;
        const current = props.pendingMessages.map((m) => m.id);
        if (ids.length === current.length && ids.every((id, idx) => id === current[idx])) {
            return;
        }
        try {
            await sync.reorderPendingMessages(props.sessionId, ids);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.reorderFailed'));
        }
    }, [props.pendingMessages, props.sessionId]);

    const handleRemove = React.useCallback(async (pendingId: string) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.removeConfirm.title'),
            t('session.pendingMessages.removeConfirm.body'),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.deleteFailed'));
        }
    }, [props.sessionId]);

    const deleteOrDiscardAfterSend = React.useCallback(async (pendingId: string) => {
        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
        } catch (deleteError) {
            try {
                await sync.discardPendingMessage(props.sessionId, pendingId);
            } catch {
                throw deleteError;
            }
        }
    }, [props.sessionId]);

    const handleSteerNow = React.useCallback(async (message: PendingMessage) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.steerConfirm.title'),
            t('session.pendingMessages.steerConfirm.body'),
            { confirmText: t('session.pendingMessages.actions.steerNow') },
        );
        if (!confirmed) return;

        try {
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: message.id,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
            });
            if (result.type === 'committed') {
                await deleteOrDiscardAfterSend(message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
        }
    }, [deleteOrDiscardAfterSend, props.sessionId]);

    const handleSendNow = React.useCallback(async (message: PendingMessage) => {
        const confirmed = await Modal.confirm(
            canSteerNow ? t('session.pendingMessages.sendConfirm.interruptTitle') : t('session.pendingMessages.sendConfirm.title'),
            t('session.pendingMessages.sendConfirm.body'),
            { confirmText: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow') },
        );
        if (!confirmed) return;

        try {
            await sessionAbort(props.sessionId);
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: message.id,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
            });
            if (result.type === 'committed') {
                await deleteOrDiscardAfterSend(message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
        }
    }, [canSteerNow, deleteOrDiscardAfterSend, props.sessionId]);

    const handleRequeueDiscarded = React.useCallback(async (pendingId: string) => {
        try {
            await sync.restoreDiscardedPendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.restoreFailed'));
        }
    }, [props.sessionId]);

    const handleRemoveDiscarded = React.useCallback(async (pendingId: string) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.discarded.removeConfirm.title'),
            t('session.pendingMessages.discarded.removeConfirm.body'),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        try {
            await sync.deleteDiscardedPendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.deleteDiscardedFailed'));
        }
    }, [props.sessionId]);

    const handleSteerDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.steerConfirm.title'),
            t('session.pendingMessages.steerConfirm.body'),
            { confirmText: t('session.pendingMessages.actions.steerNow') },
        );
        if (!confirmed) return;

        try {
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: message.id,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
            });
            if (result.type === 'committed') {
                await sync.deleteDiscardedPendingMessage(props.sessionId, message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendDiscardedFailed'));
        }
    }, [props.sessionId]);

    const handleSendDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        const confirmed = await Modal.confirm(
            canSteerNow ? t('session.pendingMessages.sendConfirm.interruptTitle') : t('session.pendingMessages.sendConfirm.title'),
            t('session.pendingMessages.sendConfirm.body'),
            { confirmText: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow') },
        );
        if (!confirmed) return;

        try {
            await sessionAbort(props.sessionId);
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: message.id,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
            });
            if (result.type === 'committed') {
                await sync.deleteDiscardedPendingMessage(props.sessionId, message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendDiscardedFailed'));
        }
    }, [canSteerNow, props.sessionId]);

    const renderMessage = React.useCallback((args: {
        message: PendingMessage;
        index: number;
        renderDragHandle: (args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => React.ReactNode;
    }) => {
        const { message, index, renderDragHandle } = args;
        const text = getPendingText(message).trim();
        const isAccepted = message.deliveryStatus === 'accepted';
        const isCollapsible = collapseThresholdChars > 0 && text.length >= collapseThresholdChars;
	        const isExpanded = expandedMessageIds[message.id] === true || !isCollapsible;

	        const menuKey = `active:${message.id}`;
	        const menuOpen = openMenuKey === menuKey;
	        const hasDecryptFailure = message.pendingDecryptFailure?.kind === 'decrypt_failed';
	        const hoveredIndex =
	            hoveredMessageId && pendingIndexById[hoveredMessageId] !== undefined
	                ? pendingIndexById[hoveredMessageId]!
	                : null;
        const hideChipBecauseNextHovered =
            isWeb && hoveredIndex !== null && hoveredIndex + 1 === index && hoveredMessageId !== message.id;

	        const menuItems = (() => {
	            const items: DropdownMenuItem[] = [];
	            items.push({ id: 'edit', title: t('session.pendingMessages.actions.edit'), icon: <Ionicons name="pencil-outline" size={16} color={theme.colors.text.secondary} /> });
	            items.push({ id: 'remove', title: t('common.remove'), icon: <Ionicons name="trash-outline" size={16} color={theme.colors.text.secondary} /> });
	            if (canSteerNow && !hasDecryptFailure) {
	                items.push({ id: 'steerNow', title: t('session.pendingMessages.actions.steerNow'), icon: <Ionicons name="navigate-outline" size={16} color={theme.colors.text.secondary} /> });
	            }
	            if (!hasDecryptFailure) {
	                items.push({
	                    id: 'sendNow',
	                    title: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow'),
	                    icon: <Ionicons name="paper-plane-outline" size={16} color={theme.colors.text.secondary} />,
	                });
	            }
	            return items;
	        })();

        return (
            <DropdownMenu
                key={message.id}
                open={menuOpen}
                onOpenChange={(next) => setOpenMenuKey(next ? menuKey : null)}
                items={menuItems}
                onSelect={async (itemId) => {
                    setOpenMenuKey(null);
                    if (itemId === 'edit') await handleEdit(message.id, message.text);
                    if (itemId === 'remove') await handleRemove(message.id);
                    if (itemId === 'steerNow') await handleSteerNow(message);
                    if (itemId === 'sendNow') await handleSendNow(message);
                }}
                placement="top"
                gap={6}
                trigger={({ toggle }) => (
                    <View
                        testID={`pendingMessages.row:${message.id}`}
                        style={[
                            styles.userMessageWrapper,
                            isWeb && (hoveredMessageId === message.id || menuOpen) ? styles.userMessageWrapperHovered : null,
                        ]}
                        {...(!isWeb ? { pointerEvents: 'box-none' as const } : null)}
                        {...(isWeb
                            ? {
                                onPointerEnter: () => setHoveredMessageId(message.id),
                                onPointerLeave: () => setHoveredMessageId((prev) => (prev === message.id ? null : prev)),
                            }
                            : null)}
                    >
                        <Pressable
                            onPress={toggle}
                            testID={`pendingMessages.message:${message.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.pendingMessages.title')}
                            style={({ pressed }) => ([
                                styles.userMessageBubble,
                                { backgroundColor: theme.colors.message.user.background, opacity: pressed ? 0.82 : 0.9 },
                            ])}
                        >
                            {isExpanded ? (
                                <MarkdownView markdown={text} textStyle={styles.transcriptMarkdownText} />
                            ) : (
                                <Text
                                    numberOfLines={collapsedLines}
                                    style={[styles.collapsedPlainText, { color: theme.colors.text.primary }]}
                                >
                                    {text}
                                </Text>
                            )}
                            {isCollapsible ? (
                                <Pressable
                                    onPress={(e: any) => {
                                        e?.stopPropagation?.();
                                        toggleMessageExpanded(message.id);
                                    }}
                                    hitSlop={10}
                                    testID={`pendingMessages.viewMore:${message.id}`}
                                    style={({ pressed }) => ({
                                        alignSelf: 'flex-start',
                                        marginTop: 6,
                                        opacity: pressed ? 0.8 : 1,
                                    })}
                                >
                                    <Text style={{ color: theme.colors.text.link, fontSize: 12, ...Typography.default('semiBold') }}>
                                        {isExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </Pressable>

                        <View
                            testID={`pendingMessages.pendingAffordance:${message.id}`}
                            {...(!isWeb ? { pointerEvents: 'none' as const } : null)}
                            style={[
                                styles.pendingAffordanceChip,
                                { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.default },
                                hideChipBecauseNextHovered ? { opacity: 0 } : null,
                                isWeb ? { pointerEvents: 'none' as const } : null,
                            ]}
                        >
                            {isAccepted ? (
                                <ActivitySpinner
                                    testID={`pendingMessages.acceptedIndicator:${message.id}`}
                                    size="small"
                                    color={theme.colors.text.secondary}
                                />
                            ) : (
                                <>
                                    <Ionicons name="time-outline" size={8} color={theme.colors.text.secondary} />
                                    <Text
                                        testID={`pendingMessages.pendingAffordanceLabel:${message.id}`}
                                        style={[styles.pendingAffordanceText, { color: theme.colors.text.secondary }]}
                                    >
                                        {t('session.pendingMessages.badgeLabel', { count: 0 })}
                                    </Text>
                                </>
                            )}
                        </View>

                        {isWeb ? (
                            <View
                                testID={`pendingMessages.actionsOverlay:${message.id}`}
                                style={[
                                    styles.messageActionContainer,
                                    !(hoveredMessageId === message.id || menuOpen) ? styles.messageActionContainerHidden : null,
                                    { pointerEvents: hoveredMessageId === message.id || menuOpen ? 'auto' : 'none' },
                                ]}
                            >
                                {props.pendingMessages.length > 1 ? (
                                    renderDragHandle({
                                        children: (
                                            <ReorderDragHandleAffordance
                                                testID={`pendingMessages.reorder:${message.id}`}
                                                accessibilityLabel={t('common.reorder')}
                                            />
                                        ),
                                        accessibilityLabel: t('common.reorder'),
                                    })
                                ) : null}
                                <IconAction
                                    testID={`pendingMessages.edit:${message.id}`}
                                    accessibilityLabel={t('session.pendingMessages.actions.edit')}
                                    icon="pencil-outline"
                                    onPress={() => handleEdit(message.id, message.text)}
                                />
                                <IconAction
                                    testID={`pendingMessages.remove:${message.id}`}
                                    accessibilityLabel={t('common.remove')}
                                    icon="trash-outline"
                                    onPress={() => handleRemove(message.id)}
                                    tone="destructive"
                                />
	                                {canSteerNow && !hasDecryptFailure ? (
	                                    <IconAction
	                                        testID={`pendingMessages.steerNow:${message.id}`}
	                                        accessibilityLabel={t('session.pendingMessages.actions.steerNow')}
	                                        icon="navigate-outline"
	                                        onPress={() => handleSteerNow(message)}
	                                    />
	                                ) : null}
	                                {!hasDecryptFailure ? (
	                                    <IconAction
	                                        testID={`pendingMessages.sendNow:${message.id}`}
	                                        accessibilityLabel={canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow')}
	                                        icon="paper-plane-outline"
	                                        onPress={() => handleSendNow(message)}
	                                    />
	                                ) : null}
	                            </View>
                        ) : props.pendingMessages.length > 1 ? (
                            <View style={styles.messageActionContainer}>
                                {renderDragHandle({
                                    children: (
                                        <ReorderDragHandleAffordance
                                            testID={`pendingMessages.reorder:${message.id}`}
                                            accessibilityLabel={t('common.reorder')}
                                        />
                                    ),
                                    accessibilityLabel: t('common.reorder'),
                                })}
                            </View>
                        ) : null}
                    </View>
                )}
            />
        );
    }, [
        canSteerNow,
        hoveredMessageId,
        collapseThresholdChars,
        collapsedLines,
        expandedMessageIds,
        handleEdit,
        handleRemove,
        handleSendNow,
        handleSteerNow,
        isWeb,
        openMenuKey,
        pendingIndexById,
        props.pendingMessages.length,
        theme.colors.border.default,
        theme.colors.surface.base,
        theme.colors.text.link,
        theme.colors.text.secondary,
        theme.colors.message.user.background,
        theme.colors.message.user.foreground,
        toggleMessageExpanded,
    ]);

    const renderDiscardedMessage = React.useCallback((message: DiscardedPendingMessage) => {
        const text = getPendingText(message).trim();
        const menuKey = `discarded:${message.id}`;
        const menuOpen = openMenuKey === menuKey;

        const menuItems: DropdownMenuItem[] = [
            { id: 'requeue', title: t('session.pendingMessages.actions.requeue'), icon: <Ionicons name="return-up-back-outline" size={16} color={theme.colors.text.secondary} /> },
            { id: 'remove', title: t('common.remove'), icon: <Ionicons name="trash-outline" size={16} color={theme.colors.text.secondary} /> },
            ...(canSteerNow ? [{ id: 'steerNow', title: t('session.pendingMessages.actions.steerNow'), icon: <Ionicons name="navigate-outline" size={16} color={theme.colors.text.secondary} /> } as const] : []),
            { id: 'sendNow', title: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow'), icon: <Ionicons name="paper-plane-outline" size={16} color={theme.colors.text.secondary} /> },
        ];

        return (
            <DropdownMenu
                key={`discarded-${message.id}`}
                open={menuOpen}
                onOpenChange={(next) => setOpenMenuKey(next ? menuKey : null)}
                items={menuItems}
                onSelect={async (itemId) => {
                    setOpenMenuKey(null);
                    if (itemId === 'requeue') await handleRequeueDiscarded(message.id);
                    if (itemId === 'remove') await handleRemoveDiscarded(message.id);
                    if (itemId === 'steerNow') await handleSteerDiscardedNow(message);
                    if (itemId === 'sendNow') await handleSendDiscardedNow(message);
                }}
                placement="top"
                gap={6}
                trigger={({ toggle }) => (
                    <View
                        testID={`pendingMessages.discarded.row:${message.id}`}
                        style={[styles.userMessageWrapper, { opacity: 0.85 }]}
                        {...(!isWeb ? { pointerEvents: 'box-none' as const } : null)}
                        {...(isWeb
                            ? {
                                onPointerEnter: () => setHoveredMessageId(message.id),
                                onPointerLeave: () => setHoveredMessageId((prev) => (prev === message.id ? null : prev)),
                            }
                            : null)}
                    >
                        <Pressable
                            onPress={toggle}
                            testID={`pendingMessages.discarded.message:${message.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.pendingMessages.discarded.label')}
                            style={({ pressed }) => ([
                                styles.userMessageBubble,
                                { backgroundColor: theme.colors.input.background, opacity: pressed ? 0.75 : 0.82 },
                            ])}
                        >
                            <Text numberOfLines={collapsedLines} style={{ color: theme.colors.text.primary, ...Typography.default() }}>
                                {text}
                            </Text>
                            <Text style={{ marginTop: 6, color: theme.colors.text.secondary, fontSize: 12, ...Typography.default('semiBold') }}>
                                {t('session.pendingMessages.discarded.label')}
                            </Text>
                        </Pressable>

                        {isWeb ? (
                            <View
                                testID={`pendingMessages.discarded.actionsOverlay:${message.id}`}
                                style={[
                                    styles.messageActionContainer,
                                    !(hoveredMessageId === message.id || menuOpen) ? styles.messageActionContainerHidden : null,
                                    { pointerEvents: hoveredMessageId === message.id || menuOpen ? 'auto' : 'none' },
                                ]}
                            >
                                <IconAction
                                    testID={`pendingMessages.discarded.requeue:${message.id}`}
                                    accessibilityLabel={t('session.pendingMessages.actions.requeue')}
                                    icon="return-up-back-outline"
                                    onPress={() => handleRequeueDiscarded(message.id)}
                                />
                                <IconAction
                                    testID={`pendingMessages.discarded.remove:${message.id}`}
                                    accessibilityLabel={t('common.remove')}
                                    icon="trash-outline"
                                    onPress={() => handleRemoveDiscarded(message.id)}
                                    tone="destructive"
                                />
                                {canSteerNow ? (
                                    <IconAction
                                        testID={`pendingMessages.discarded.steerNow:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.steerNow')}
                                        icon="navigate-outline"
                                        onPress={() => handleSteerDiscardedNow(message)}
                                    />
                                ) : null}
                                <IconAction
                                    testID={`pendingMessages.discarded.sendNow:${message.id}`}
                                    accessibilityLabel={canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt') : t('session.pendingMessages.actions.sendNow')}
                                    icon="paper-plane-outline"
                                    onPress={() => handleSendDiscardedNow(message)}
                                />
                            </View>
                        ) : null}
                    </View>
                )}
            />
        );
    }, [
        canSteerNow,
        collapsedLines,
        hoveredMessageId,
        handleRequeueDiscarded,
        handleRemoveDiscarded,
        handleSendDiscardedNow,
        handleSteerDiscardedNow,
        isWeb,
        openMenuKey,
        theme.colors.input.background,
        theme.colors.text.primary,
        theme.colors.text.secondary,
    ]);

    const displayedDiscarded = React.useMemo(() => {
        return props.discardedMessages.slice().sort((a, b) => a.discardedAt - b.discardedAt);
    }, [props.discardedMessages]);

    const scrollEdge = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });

    if (pendingCount <= 0 && discardedCount <= 0) return null;

    const canExpandPendingQueue =
        pendingCount > 0
        && typeof scrollContentHeightPx === 'number'
        && Number.isFinite(scrollContentHeightPx)
        && scrollContentHeightPx > maxHeightPx;
    const isQueueExpanded = canExpandPendingQueue && isPendingQueueExpanded;
    const maxHeight = isQueueExpanded ? expandedMaxHeightPx : maxHeightPx;
    const headerLabel =
        pendingCount > 0
            ? `${t('session.pendingMessages.title')} (${pendingCount})`
            : t('session.pendingMessages.discarded.title');
    const clampedViewportHeightPx =
        typeof scrollContentHeightPx === 'number' && Number.isFinite(scrollContentHeightPx) && scrollContentHeightPx > 0
            ? Math.max(1, Math.min(Math.trunc(scrollContentHeightPx), maxHeight))
            : undefined;

    return (
        <View testID="pendingMessages.block" style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
            <View style={styles.messageContent}>
                <View style={styles.userMessageContainer}>
                    <View style={{ width: '100%', maxWidth: layout.maxWidth }}>
                        <View style={styles.sectionHeader}>
                            <TranscriptSeparatorRow
                                iconName="time-outline"
                                title={headerLabel}
                                titleTestID="pendingMessages.headerLabel"
                                chipTestID={canExpandPendingQueue ? 'pendingMessages.headerToggle' : undefined}
                                onPress={canExpandPendingQueue ? togglePendingQueueExpanded : undefined}
                                accessibilityLabel={isQueueExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}
                                subtitle={discardedCount > 0 && pendingCount > 0 ? `${t('session.pendingMessages.discarded.label')} (${discardedCount})` : null}
                                rightAccessory={canExpandPendingQueue ? (
                                    <Ionicons
                                        name={isQueueExpanded ? 'chevron-up' : 'chevron-down'}
                                        size={13}
                                        color={theme.colors.text.secondary}
                                    />
                                ) : null}
                                padding="none"
                            />
                        </View>

                        {showNonSteerableNotice ? (
                            <View
                                testID="pendingMessages.nonSteerableNotice"
                                style={[
                                    styles.nonSteerableNotice,
                                    {
                                        backgroundColor: theme.colors.surface.base,
                                        borderColor: theme.colors.border.default,
                                    },
                                ]}
                            >
                                <Ionicons name="pause-circle-outline" size={13} color={theme.colors.text.secondary} />
                                <Text style={[styles.nonSteerableNoticeText, { color: theme.colors.text.secondary }]}>
                                    {t('session.pendingMessages.nonSteerableNotice')}
                                </Text>
                            </View>
                        ) : null}

                        <View style={{ position: 'relative' }}>
                            <ScrollView
                                testID="pendingMessages.scroll"
                                style={{ height: clampedViewportHeightPx, maxHeight: maxHeight, marginTop: 8 }}
                                contentContainerStyle={{ paddingTop: 14, paddingBottom: 2 }}
                                ref={scrollRef}
                                nestedScrollEnabled={true}
                                scrollEventThrottle={16}
                                onLayout={(e) => {
                                    setScrollViewportHeightPx(e.nativeEvent.layout.height);
                                    scrollEdge.onViewportLayout(e);
                                }}
                                onContentSizeChange={(w, h) => {
                                    setScrollContentHeightPx(h);
                                    scrollEdge.onContentSizeChange(w, h);
                                }}
                                onScroll={(e) => {
                                    const y = e.nativeEvent.contentOffset.y;
                                    setScrollOffsetY(typeof y === 'number' && Number.isFinite(y) ? Math.max(0, Math.trunc(y)) : null);
                                    scrollEdge.onScroll(e);
                                }}
                            >
                                <PendingMessagesDragReorderList
                                    messages={props.pendingMessages}
                                    estimatedRowHeightPx={reorderEstimatedRowHeightPx}
                                    longPressMs={200}
                                    scrollRef={scrollRef}
                                    viewportHeightPx={scrollViewportHeightPx}
                                    scrollOffsetY={scrollOffsetY}
                                    onReorderIds={handleReorderIds}
                                    renderItem={({ message, index, renderDragHandle }) => renderMessage({ message, index, renderDragHandle })}
                                />
                                {displayedDiscarded.length > 0 ? (
                                    <View style={{ marginTop: 4 }}>
                                        <Text style={[styles.discardedTitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.title')}
                                        </Text>
                                        <Text style={[styles.discardedSubtitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.subtitle')}
                                        </Text>
                                        <View style={{ marginTop: 10 }}>
                                            {displayedDiscarded.map(renderDiscardedMessage)}
                                        </View>
                                    </View>
                                ) : null}
                            </ScrollView>

                            <ScrollEdgeFades
                                color={theme.colors.surface.base}
                                edges={{ top: scrollEdge.visibility.top, bottom: scrollEdge.visibility.bottom }}
                            />
                            <ScrollEdgeIndicators
                                color={theme.colors.text.secondary}
                                edges={{ top: scrollEdge.visibility.top, bottom: scrollEdge.visibility.bottom }}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}

function IconAction(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    tone?: 'default' | 'destructive';
}) {
    const { theme } = useUnistyles();
    const isDestructive = props.tone === 'destructive';
    const tint = isDestructive ? theme.colors.state.danger.foreground : theme.colors.text.secondary;
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            style={({ pressed }) => ({
                padding: 2,
                borderRadius: 6,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.colors.surface.pressedOverlay : 'transparent',
                opacity: pressed ? 1 : 0.65,
                ...(Platform.OS === 'web' ? { cursor: 'pointer' as const } : null),
            })}
        >
            <Ionicons name={props.icon} size={12} color={tint} />
        </Pressable>
    );
}

function ReorderDragHandleAffordance(props: {
    accessibilityLabel: string;
    testID?: string;
}) {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            {...(!isWeb ? { pointerEvents: 'none' as const } : null)}
            style={[
                {
                    padding: 2,
                    borderRadius: 6,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.65,
                },
                isWeb ? ({ pointerEvents: 'none' } as const) : null,
            ]}
        >
            <Ionicons name="reorder-three-outline" size={12} color={theme.colors.text.secondary} />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    messageContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    messageContent: {
        flexDirection: 'column',
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: layout.maxWidth,
    },
    userMessageContainer: {
        maxWidth: '100%',
        flexDirection: 'column',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
    },
    sectionHeader: {
        marginTop: 2,
    },
    pendingAffordanceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    pendingAffordanceText: {
        fontSize: 8,
        ...Typography.default('semiBold'),
    },
    pendingAffordanceChip: {
        position: 'absolute',
        top: -8,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        zIndex: 20,
    },
    nonSteerableNotice: {
        marginTop: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    nonSteerableNoticeText: {
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    userMessageWrapper: {
        maxWidth: '100%',
        alignSelf: 'flex-end',
        position: 'relative',
        paddingBottom: 16,
    },
    userMessageWrapperHovered: {
        zIndex: 60,
    },
    userMessageBubble: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        maxWidth: '100%',
    },
    transcriptMarkdownText: {
        ...transcriptMarkdownTextStyle,
    },
    collapsedPlainText: {
        ...Typography.default(),
        fontSize: transcriptMarkdownTextStyle.fontSize,
        lineHeight: transcriptMarkdownTextStyle.lineHeight,
        marginTop: 0,
        marginBottom: 0,
    },
    messageActionContainer: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        zIndex: 40,
        opacity: 1,
        gap: 3,
    },
    messageActionContainerHidden: {
        opacity: 0,
    },
    discardedTitle: {
        marginTop: 6,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    discardedSubtitle: {
        marginTop: 4,
        fontSize: 12,
        ...Typography.default(),
    },
}));
