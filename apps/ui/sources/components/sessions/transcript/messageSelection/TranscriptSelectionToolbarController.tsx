import * as React from 'react';

import { useSessionMessages } from '@/sync/store/hooks';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { isSessionDebugInformationEnabled } from '@/components/sessions/debug/sessionDebugInformation';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { useTranscriptSelectionState } from './TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar, type TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';
import { resolveTranscriptSelectionToolbarMessages } from './resolveTranscriptSelectionToolbarMessages';

const EMPTY_SELECTABLE_MESSAGES: readonly TranscriptSelectionToolbarMessage[] = Object.freeze([]);

export function TranscriptSelectionToolbarController(props: Readonly<{
    sessionId: string;
    metadata?: Metadata | null;
    enabled?: boolean;
    bulkCopyFormat: React.ComponentProps<typeof TranscriptSelectionToolbar>['bulkCopyFormat'];
    roleLabels: React.ComponentProps<typeof TranscriptSelectionToolbar>['roleLabels'];
    sendToSessionEnabled: boolean;
    maxWidth?: number;
    onSendToSession?: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => void | Promise<void>;
}>): React.ReactElement | null {
    const selection = useTranscriptSelectionState();
    const enabled = props.enabled !== false;
    const shouldReadSelectableMessages = enabled && selection.isSelectionMode;
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const debugInformationEnabled = isSessionDebugInformationEnabled(useLocalSetting('devModeEnabled'));
    const { messages } = useSessionMessages(props.sessionId, {
        enabled: shouldReadSelectableMessages,
    });
    const selectableMessages = React.useMemo(
        () => shouldReadSelectableMessages
            ? resolveTranscriptSelectionToolbarMessages(messages, props.metadata, {
                sessionThinkingDisplayMode,
                debugInformationEnabled,
            })
            : EMPTY_SELECTABLE_MESSAGES,
        [debugInformationEnabled, messages, props.metadata, sessionThinkingDisplayMode, shouldReadSelectableMessages],
    );

    if (!enabled) return null;

    return (
        <TranscriptSelectionToolbar
            selectableMessagesInOrder={selectableMessages}
            bulkCopyFormat={props.bulkCopyFormat}
            roleLabels={props.roleLabels}
            sendToSessionEnabled={props.sendToSessionEnabled}
            maxWidth={props.maxWidth}
            onSendToSession={props.onSendToSession}
        />
    );
}
