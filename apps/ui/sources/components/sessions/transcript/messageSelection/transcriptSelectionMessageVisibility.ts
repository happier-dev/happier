import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { readUnsupportedContentMeta } from '@/sync/domains/messages/unsupportedContentMeta';
import { resolveUnsupportedContentPresentation } from '@/sync/domains/messages/unsupportedContentPresentation';

export type TranscriptSelectionThinkingDisplayMode = Settings['sessionThinkingDisplayMode'];

export type TranscriptSelectionMessageVisibilityOptions = Readonly<{
    sessionThinkingDisplayMode?: TranscriptSelectionThinkingDisplayMode | null;
    debugInformationEnabled?: boolean | null;
}>;

export function normalizeTranscriptSelectionThinkingVisibility(
    sessionThinkingDisplayMode: TranscriptSelectionThinkingDisplayMode | null | undefined,
): 'hidden' | 'visible' {
    return sessionThinkingDisplayMode === 'hidden' ? 'hidden' : 'visible';
}

export function shouldExcludeMessageFromTranscriptSelection(
    message: Message,
    options?: TranscriptSelectionMessageVisibilityOptions | null,
): boolean {
    if (isTranscriptSelectionHiddenUnsupportedContent(message, options?.debugInformationEnabled === true)) return true;
    return normalizeTranscriptSelectionThinkingVisibility(options?.sessionThinkingDisplayMode) === 'hidden'
        && message.kind === 'agent-text'
        && message.isThinking === true;
}

/**
 * A placeholder row that is not rendered must not stay selectable: otherwise a range selection or
 * select-all can copy a diagnostic the user cannot see.
 */
export function isTranscriptSelectionHiddenUnsupportedContent(
    message: Message,
    debugInformationEnabled: boolean,
): boolean {
    const kind = readUnsupportedContentMeta(message.meta);
    if (!kind) return false;
    return resolveUnsupportedContentPresentation({ kind, debugInformationEnabled }) === 'hidden';
}
