import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';

import { useTranscriptSelectionState } from './TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar, type TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';
import { resolveTranscriptSelectionToolbarMessages } from './resolveTranscriptSelectionToolbarMessages';
import { TranscriptSelectionToolbarSeat } from './TranscriptSelectionToolbarSeat';
import { useSessionDebugInformationEnabled } from '@/sync/runtime/useSessionDebugInformationEnabled';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';

type TranscriptSelectionToolbarControllerProps = Readonly<{
    enabled?: boolean;
    bulkCopyFormat: React.ComponentProps<typeof TranscriptSelectionToolbar>['bulkCopyFormat'];
    roleLabels: React.ComponentProps<typeof TranscriptSelectionToolbar>['roleLabels'];
    sendToSessionEnabled: boolean;
    maxWidth?: number;
    onSendToSession?: (messages: ReadonlyArray<TranscriptSelectionToolbarMessage>) => void | Promise<void>;
}>;

export function TranscriptSelectionToolbarController(props: TranscriptSelectionToolbarControllerProps): React.ReactElement | null {
    const selection = useTranscriptSelectionState();
    if (props.enabled === false || !selection.isSelectionMode) return null;
    return <TranscriptSelectionToolbarSourceContent {...props} />;
}

/** Selection is the consumer of the detailed dataset; closed toolbars do not subscribe. */
function TranscriptSelectionToolbarSourceContent(props: TranscriptSelectionToolbarControllerProps): React.ReactElement {
    const source = useSessionTranscriptSource();
    const ids = source.useMessageIdsOldestFirst();
    const byId = source.useMessagesById();
    const metadata = source.useMetadata();
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const debugInformationEnabled = useSessionDebugInformationEnabled();
    const messages = React.useMemo(() => ids.flatMap((id) => byId[id] ? [byId[id]] : []), [byId, ids]);
    const selectableMessages = React.useMemo(
        () => resolveTranscriptSelectionToolbarMessages(messages, metadata, {
            sessionThinkingDisplayMode,
            debugInformationEnabled,
        }),
        [debugInformationEnabled, messages, metadata, sessionThinkingDisplayMode],
    );

    return (
        <TranscriptSelectionToolbarSeat>
            <TranscriptSelectionToolbar
                selectableMessagesInOrder={selectableMessages}
                bulkCopyFormat={props.bulkCopyFormat}
                roleLabels={props.roleLabels}
                sendToSessionEnabled={props.sendToSessionEnabled}
                maxWidth={props.maxWidth}
                onSendToSession={props.onSendToSession}
            />
        </TranscriptSelectionToolbarSeat>
    );
}
