import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readUnsupportedContentMeta } from '@/sync/domains/messages/unsupportedContentMeta';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';
import { resolveUnsupportedContentPresentation } from '@/sync/domains/messages/unsupportedContentPresentation';
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
        const unsupportedContentMeta = readUnsupportedContentMeta(message.meta);
        // Copying a placeholder yields what the row shows: the raw diagnostic when developer
        // diagnostics are on, the localized label otherwise.
        const keepRawDiagnostic = unsupportedContentMeta != null
            && resolveUnsupportedContentPresentation({
                kind: unsupportedContentMeta,
                debugInformationEnabled: visibilityOptions?.debugInformationEnabled === true,
            }) === 'diagnostic'
            && selectable.text.trim().length > 0;
        const resolved = unsupportedContentMeta && !keepRawDiagnostic
            ? { ...selectable, text: resolveUnsupportedContentLabel(unsupportedContentMeta) }
            : selectable;
        selectableMessages.push({ id: message.id, ...resolved });
    }
    return selectableMessages;
}
