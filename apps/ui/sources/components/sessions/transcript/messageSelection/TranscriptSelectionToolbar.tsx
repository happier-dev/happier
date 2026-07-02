import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { TranscriptBulkCopyFormat, TranscriptSelectableMessageText } from './_types';
import { formatSelectedMessagesForClipboard } from './formatSelectedMessagesForClipboard';
import { useTranscriptSelectionActions, useTranscriptSelectionState } from './TranscriptMessageSelectionContext';

export type TranscriptSelectionToolbarMessage = TranscriptSelectableMessageText & Readonly<{ id: string }>;

const TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS = 1200;

export function TranscriptSelectionToolbar(props: Readonly<{
    selectableMessagesInOrder: ReadonlyArray<TranscriptSelectionToolbarMessage>;
    bulkCopyFormat: TranscriptBulkCopyFormat;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    sendToSessionEnabled: boolean;
    maxWidth?: number;
    onSendToSession?: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => void | Promise<void>;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const state = useTranscriptSelectionState();
    const actions = useTranscriptSelectionActions();
    const [busyAction, setBusyAction] = React.useState<'copy' | 'send' | null>(null);
    const [copySucceeded, setCopySucceeded] = React.useState(false);
    const copyFeedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => () => {
        if (copyFeedbackTimerRef.current) {
            clearTimeout(copyFeedbackTimerRef.current);
        }
    }, []);

    const selectedMessages = React.useMemo(
        () => props.selectableMessagesInOrder.filter((message) => state.selectedIds.has(message.id)),
        [props.selectableMessagesInOrder, state.selectedIds],
    );

    const handleCopy = React.useCallback(async () => {
        if (selectedMessages.length === 0 || busyAction) return;
        const text = formatSelectedMessagesForClipboard(selectedMessages, {
            format: props.bulkCopyFormat,
            roleLabels: props.roleLabels,
        });
        setBusyAction('copy');
        try {
            const ok = await setClipboardStringSafe(text);
            if (!ok) {
                Modal.alert(t('common.error'), t('transcript.selection.copyFailed'));
                return;
            }
            setCopySucceeded(true);
            if (copyFeedbackTimerRef.current) {
                clearTimeout(copyFeedbackTimerRef.current);
            }
            copyFeedbackTimerRef.current = setTimeout(() => {
                setCopySucceeded(false);
                copyFeedbackTimerRef.current = null;
            }, TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS);
        } catch {
            Modal.alert(t('common.error'), t('transcript.selection.copyFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [busyAction, props.bulkCopyFormat, props.roleLabels, selectedMessages]);

    const handleSend = React.useCallback(async () => {
        if (!props.onSendToSession || selectedMessages.length === 0 || busyAction) return;
        setBusyAction('send');
        try {
            await props.onSendToSession(selectedMessages);
        } finally {
            setBusyAction(null);
        }
    }, [busyAction, props, selectedMessages]);

    const shortcutHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!state.isSelectionMode) return {};
        const handlers: KeyboardShortcutHandlers = {
            'transcript.selection.cancel': actions.exit,
            'transcript.selection.copy': () => { void handleCopy(); },
            'transcript.selection.selectAll': () => actions.selectAll(props.selectableMessagesInOrder.map((message) => message.id)),
        };
        if (props.sendToSessionEnabled && props.onSendToSession) {
            handlers['transcript.selection.sendToSession'] = () => { void handleSend(); };
        }
        return handlers;
    }, [actions, handleCopy, handleSend, props.onSendToSession, props.selectableMessagesInOrder, props.sendToSessionEnabled, state.isSelectionMode]);
    useKeyboardShortcutHandlers(shortcutHandlers);

    if (!state.isSelectionMode) return null;

    return (
        <View
            testID="transcript-selection-toolbar"
            accessibilityLiveRegion="polite"
            style={[
                styles.container,
                typeof props.maxWidth === 'number' && Number.isFinite(props.maxWidth) ? { width: '100%' as const, maxWidth: props.maxWidth, alignSelf: 'center' as const } : null,
                { borderColor: theme.colors.border.default },
            ]}
        >
            <View style={styles.statusTextGroup}>
                <Text testID="transcript-selection-toolbar-count" style={styles.countText}>
                    {t('transcript.selection.selectedCount', { count: state.count })}
                </Text>
                {copySucceeded ? (
                    <Text testID="transcript-selection-copy-feedback" style={styles.feedbackText}>
                        {t('transcript.selection.copySuccess')}
                    </Text>
                ) : null}
            </View>
            <View style={styles.actions}>
                <ToolbarButton
                    testID="transcript-selection-copy"
                    label={t('transcript.selection.copy')}
                    accessibilityLabel={t('transcript.selection.copyA11y', { count: state.count })}
                    disabled={selectedMessages.length === 0 || busyAction != null}
                    onPress={handleCopy}
                />
                {props.sendToSessionEnabled && props.onSendToSession ? (
                    <ToolbarButton
                        testID="transcript-selection-send"
                        label={t('transcript.selection.send')}
                        accessibilityLabel={t('transcript.selection.sendA11y', { count: state.count })}
                        disabled={selectedMessages.length === 0 || busyAction != null}
                        onPress={handleSend}
                    />
                ) : null}
                <ToolbarButton
                    testID="transcript-selection-select-all"
                    label={t('transcript.selection.selectAll')}
                    onPress={() => actions.selectAll(props.selectableMessagesInOrder.map((message) => message.id))}
                />
                <ToolbarButton
                    testID="transcript-selection-cancel"
                    label={t('transcript.selection.cancel')}
                    accessibilityLabel={t('transcript.selection.exitA11y')}
                    onPress={actions.exit}
                />
            </View>
        </View>
    );
}

function ToolbarButton(props: Readonly<{
    testID: string;
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void | Promise<void>;
}>): React.ReactElement {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            accessibilityState={props.disabled ? { disabled: true } : undefined}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed }) => [styles.actionButton, pressed ? styles.actionButtonPressed : null, props.disabled ? styles.actionButtonDisabled : null]}
        >
            <Text style={styles.actionButtonText}>{props.label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface.elevated,
    },
    statusTextGroup: {
        gap: 2,
    },
    countText: {
        color: theme.colors.text.secondary,
    },
    feedbackText: {
        color: theme.colors.state.success.foreground,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionButton: {
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.button.secondary.background,
    },
    actionButtonPressed: {
        backgroundColor: theme.colors.state.neutral.background,
    },
    actionButtonDisabled: {
        opacity: 0.5,
    },
    actionButtonText: {
        color: theme.colors.button.secondary.tint,
    },
}));
