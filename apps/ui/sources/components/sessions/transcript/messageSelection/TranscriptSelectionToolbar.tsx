import * as React from 'react';
import type { HappierSelectionActionBarAction } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icons/Icon';
import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';

import type { TranscriptBulkCopyFormat, TranscriptSelectableMessageText } from './_types';
import { formatSelectedMessagesForClipboard } from './formatSelectedMessagesForClipboard';
import { useTranscriptSelectionActions, useTranscriptSelectionState } from './TranscriptMessageSelectionContext';

export type TranscriptSelectionToolbarMessage = TranscriptSelectableMessageText & Readonly<{ id: string }>;

export type TranscriptSelectionToolbarAction = Readonly<{
    testID: string;
    label: string;
    accessibilityLabel?: string;
    primary?: boolean;
    onPress: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => void | Promise<void>;
}>;

const TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS = 1200;

export function TranscriptSelectionToolbar(props: Readonly<{
    selectableMessagesInOrder: ReadonlyArray<TranscriptSelectionToolbarMessage>;
    bulkCopyFormat: TranscriptBulkCopyFormat;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    sendToSessionEnabled: boolean;
    maxWidth?: number;
    /** Allows another canonical message owner to supply the same neutral selection text. */
    formatSelection?: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => string | null;
    selectionUnavailableText?: string;
    /**
     * The caller's own selection actions. At most one is `primary` (what this selection was made for,
     * e.g. Ask an agent); it stays beside Copy, and Send to session then waits under ⋯ with the rest,
     * so the bar keeps one primary. Without a primary every action stays inline, as on a Session.
     */
    additionalActions?: ReadonlyArray<TranscriptSelectionToolbarAction>;
    onSendToSession?: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => void | Promise<void>;
}>): React.ReactElement | null {
    const state = useTranscriptSelectionState();
    const transcriptSource = useOptionalSessionTranscriptSource();
    const writeClipboard = useClipboardWrite(transcriptSource?.serverId, { enabled: state.selectedIds.size > 0 });
    const actions = useTranscriptSelectionActions();
    const [busyAction, setBusyAction] = React.useState<'copy' | 'send' | 'additional' | null>(null);
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
    const formattedSelection = React.useMemo(() => {
        if (selectedMessages.length === 0) return null;
        return props.formatSelection
            ? props.formatSelection(selectedMessages)
            : formatSelectedMessagesForClipboard(selectedMessages, {
                format: props.bulkCopyFormat,
                roleLabels: props.roleLabels,
            });
    }, [props.bulkCopyFormat, props.formatSelection, props.roleLabels, selectedMessages]);
    const selectionUnavailable = selectedMessages.length > 0 && formattedSelection === null;

    const handleCopy = React.useCallback(async () => {
        if (formattedSelection === null || busyAction) return;
        setBusyAction('copy');
        try {
            const ok = await writeClipboard(formattedSelection);
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
    }, [busyAction, formattedSelection, writeClipboard]);

    const handleAdditionalAction = React.useCallback(async (action: TranscriptSelectionToolbarAction) => {
        if (selectedMessages.length === 0 || selectionUnavailable || busyAction) return;
        setBusyAction('additional');
        try {
            await action.onPress(selectedMessages);
        } finally {
            setBusyAction(null);
        }
    }, [busyAction, selectedMessages, selectionUnavailable]);

    const handleSend = React.useCallback(async () => {
        if (!props.onSendToSession || selectedMessages.length === 0 || selectionUnavailable || busyAction) return;
        setBusyAction('send');
        try {
            await props.onSendToSession(selectedMessages);
        } finally {
            setBusyAction(null);
        }
    }, [busyAction, props.onSendToSession, selectedMessages, selectionUnavailable]);

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

    const outwardDisabled = selectedMessages.length === 0 || selectionUnavailable || busyAction != null;
    const additionalActions = props.additionalActions ?? [];
    const callerPrimary = additionalActions.some((action) => action.primary === true);
    const barActions: HappierSelectionActionBarAction[] = [
        {
            id: 'copy',
            testID: 'transcript-selection-copy',
            label: t('transcript.selection.copy'),
            accessibilityLabel: t('transcript.selection.copyA11y', { count: state.count }),
            disabled: outwardDisabled,
            renderIcon: (color) => <Icon name="copy" size={14} color={color} />,
            onPress: handleCopy,
        },
        ...(props.sendToSessionEnabled && props.onSendToSession ? [{
            id: 'send',
            testID: 'transcript-selection-send',
            label: t('transcript.selection.send'),
            accessibilityLabel: t('transcript.selection.sendA11y', { count: state.count }),
            disabled: outwardDisabled,
            renderIcon: (color: string) => <Icon name="arrow-right" size={14} color={color} />,
            ...(callerPrimary ? { placement: 'menu' as const } : {}),
            onPress: handleSend,
        }] : []),
        ...additionalActions.map((action, index) => ({
            id: `additional:${index}`,
            testID: action.testID,
            label: action.label,
            accessibilityLabel: action.accessibilityLabel,
            // The caller's primary (Ask Agent) is the one this selection was made for; the rest wait under ⋯.
            ...(action.primary ? { emphasis: 'primary' as const } : callerPrimary ? { placement: 'menu' as const } : {}),
            disabled: outwardDisabled,
            ...(action.primary ? { renderIcon: (color: string) => <Icon name="sparkle" size={14} color={color} /> } : {}),
            onPress: () => handleAdditionalAction(action),
        })),
        {
            id: 'select-all',
            testID: 'transcript-selection-select-all',
            label: t('transcript.selection.selectAll'),
            onPress: () => actions.selectAll(props.selectableMessagesInOrder.map((message) => message.id)),
        },
    ];
    const status = copySucceeded
        ? t('transcript.selection.copySuccess')
        : selectionUnavailable && props.selectionUnavailableText ? props.selectionUnavailableText : null;

    return (
        <View
            accessibilityLiveRegion="polite"
            style={typeof props.maxWidth === 'number' && Number.isFinite(props.maxWidth)
                ? { width: '100%', maxWidth: props.maxWidth, alignSelf: 'center' }
                : { width: '100%' }}
        >
            <SelectionActionBar
                visible={state.isSelectionMode}
                testID="transcript-selection-toolbar"
                label={t('transcript.selection.selectedCount', { count: state.count })}
                labelTestID="transcript-selection-toolbar-count"
                status={status}
                statusTestID={copySucceeded ? 'transcript-selection-copy-feedback' : 'transcript-selection-unavailable'}
                actions={barActions}
                dismiss={{
                    testID: 'transcript-selection-cancel',
                    label: t('transcript.selection.exitA11y'),
                    onPress: actions.exit,
                }}
            />
        </View>
    );
}
