import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { PendingMessagesModal } from './PendingMessagesModal';
import { sync } from '@/sync/sync';
import { sessionAbort } from '@/sync/ops';
import type { PendingMessage } from '@/sync/storageTypes';

export const PendingQueueIndicator = React.memo((props: { sessionId: string; count: number; messages?: PendingMessage[]; isLoaded?: boolean }) => {
    const { theme } = useUnistyles();
    const messages = props.messages ?? [];
    const first = messages.length > 0 ? messages[0] : null;
    const total = Math.max(props.count, messages.length);

    if (total <= 0) return null;

    const openAll = () => {
        Modal.show({
            component: PendingMessagesModal,
            props: { sessionId: props.sessionId }
        });
    };

    const moreCount = first ? Math.max(0, total - 1) : total;
    const firstPreviewText = getPendingPreviewText(first);

    const handleEdit = React.useCallback(async () => {
        if (!first) return;
        const next = await Modal.prompt(
            'Edit pending message',
            undefined,
            { defaultValue: typeof first.text === 'string' ? first.text : '', confirmText: 'Save' }
        );
        if (next === null) return;
        if (!next.trim()) return;
        try {
            await sync.updatePendingMessage(props.sessionId, first.id, next);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to update pending message');
        }
    }, [first, props.sessionId]);

    const handleRemove = React.useCallback(async () => {
        if (!first) return;
        const confirmed = await Modal.confirm(
            'Remove pending message?',
            'This will delete the pending message.',
            { confirmText: 'Remove', destructive: true }
        );
        if (!confirmed) return;
        try {
            await sync.deletePendingMessage(props.sessionId, first.id);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to delete pending message');
        }
    }, [first, props.sessionId]);

    const handleSendNow = React.useCallback(async () => {
        if (!first) return;
        const textToSend = typeof first.text === 'string' ? first.text : '';
        if (!textToSend.trim()) {
            Modal.alert('Error', 'This pending message is empty.');
            return;
        }
        const confirmed = await Modal.confirm(
            'Send now?',
            'This will stop the current turn and send this message immediately.',
            { confirmText: 'Send now' }
        );
        if (!confirmed) return;

        try {
            await sync.deletePendingMessage(props.sessionId, first.id);
            await sessionAbort(props.sessionId);
            await sync.sendMessage(props.sessionId, textToSend);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to send pending message');
        }
    }, [first, props.sessionId]);

    return (
        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <View style={{
                backgroundColor: theme.colors.input.background,
                borderRadius: 14,
                padding: 12,
                gap: 10,
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <Pressable
                        onPress={openAll}
                        style={(p) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            opacity: p.pressed ? 0.85 : 1,
                        })}
                    >
                        <Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={{
                            marginLeft: 8,
                            color: theme.colors.text,
                            fontSize: 13,
                            fontWeight: '600',
                            ...Typography.default('semiBold')
                        }}>
                            Pending ({total})
                        </Text>
                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} style={{ marginLeft: 6 }} />
                    </Pressable>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        {props.isLoaded === false && (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        )}
                        {moreCount > 0 && (
                            <Pressable onPress={openAll} style={(p) => ({ opacity: p.pressed ? 0.75 : 1 })}>
                                <Text style={{ color: theme.colors.textLink, fontSize: 13, ...Typography.default() }}>
                                    +{moreCount} more
                                </Text>
                            </Pressable>
                        )}
                    </View>
                </View>

                {first && (
                    <>
                        <Text
                            numberOfLines={2}
                            style={{
                                color: theme.colors.text,
                                fontSize: 14,
                                ...Typography.default(),
                            }}
                        >
                            {firstPreviewText || '(empty message)'}
                        </Text>

                        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                            <InlineActionButton title="Edit" icon="create-outline" onPress={handleEdit} theme={theme} />
                            <InlineActionButton title="Send now" icon="send" onPress={handleSendNow} theme={theme} variant="primary" />
                            <InlineActionButton title="Remove" icon="trash-outline" onPress={handleRemove} theme={theme} variant="destructive" />
                        </View>
                    </>
                )}
            </View>
        </View>
    );
});

function getPendingPreviewText(message: PendingMessage | null): string {
    if (!message) return '';
    const displayText = typeof message.displayText === 'string' ? message.displayText : '';
    if (displayText.trim()) return displayText.trim();
    const text = typeof message.text === 'string' ? message.text : '';
    return text.trim();
}

function InlineActionButton(props: {
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    theme: any;
    variant?: 'neutral' | 'primary' | 'destructive';
}) {
    const variant = props.variant ?? 'neutral';
    const backgroundColor = (() => {
        if (variant === 'primary') return props.theme.colors.button.primary.background;
        if (variant === 'destructive') return props.theme.colors.box.error.background;
        return props.theme.colors.surface;
    })();
    const textColor = (() => {
        if (variant === 'primary') return props.theme.colors.button.primary.tint;
        if (variant === 'destructive') return props.theme.colors.box.error.text;
        return props.theme.colors.text;
    })();

    return (
        <Pressable
            onPress={props.onPress}
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 10,
                backgroundColor: variant === 'neutral' && p.pressed ? props.theme.colors.surfacePressed : backgroundColor,
                borderWidth: variant === 'neutral' ? 1 : 0,
                borderColor: variant === 'neutral' ? props.theme.colors.divider : 'transparent',
                opacity: p.pressed ? 0.85 : 1,
            })}
        >
            <Ionicons name={props.icon} size={14} color={textColor} />
            <Text style={{
                color: textColor,
                fontWeight: '600',
                ...Typography.default('semiBold'),
            }}>
                {props.title}
            </Text>
        </Pressable>
    );
}
