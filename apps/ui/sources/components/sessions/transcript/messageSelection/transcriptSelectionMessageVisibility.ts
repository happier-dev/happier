import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Settings } from '@/sync/domains/settings/settings';

export type TranscriptSelectionThinkingDisplayMode = Settings['sessionThinkingDisplayMode'];

export type TranscriptSelectionMessageVisibilityOptions = Readonly<{
    sessionThinkingDisplayMode?: TranscriptSelectionThinkingDisplayMode | null;
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
    return normalizeTranscriptSelectionThinkingVisibility(options?.sessionThinkingDisplayMode) === 'hidden'
        && message.kind === 'agent-text'
        && message.isThinking === true;
}
