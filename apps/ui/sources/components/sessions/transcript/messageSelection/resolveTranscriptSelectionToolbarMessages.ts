import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { isCommittedMessageDiscarded } from '@/utils/sessions/discardedCommittedMessages';

import type { TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';
import { resolveSelectableMessageText } from './resolveSelectableMessageText';
import {
    shouldExcludeMessageFromTranscriptSelection,
    type TranscriptSelectionMessageVisibilityOptions,
} from './transcriptSelectionMessageVisibility';

export function resolveTranscriptSelectionToolbarMessages(
    messagesInOrder: ReadonlyArray<Message>,
    metadata?: Metadata | null,
    visibilityOptions?: TranscriptSelectionMessageVisibilityOptions | null,
): ReadonlyArray<TranscriptSelectionToolbarMessage> {
    const selectableMessages: TranscriptSelectionToolbarMessage[] = [];
    for (const message of messagesInOrder) {
        if (message.kind !== 'user-text' && message.kind !== 'agent-text') continue;
        if (shouldExcludeMessageFromTranscriptSelection(message, visibilityOptions)) continue;
        if (message.kind === 'user-text' && isCommittedMessageDiscarded(metadata ?? null, message.localId ?? null)) continue;
        const parsedSessionMediaMeta = parseSessionMediaMessageMeta(message.meta);
        const hasLegacyAttachments = parsedSessionMediaMeta != null
            && 'legacyAttachments' in parsedSessionMediaMeta
            && parsedSessionMediaMeta.legacyAttachments != null;
        const selectable = resolveSelectableMessageText({
            message,
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: message.kind === 'user-text' && hasLegacyAttachments,
        });
        if (!selectable) continue;
        selectableMessages.push({ id: message.id, ...selectable });
    }
    return selectableMessages;
}
