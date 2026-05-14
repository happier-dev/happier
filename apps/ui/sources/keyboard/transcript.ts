export type TranscriptFocusOwner = 'transcript' | 'composer' | 'editor' | 'terminal' | 'other' | null;
export type TranscriptKeyboardNavigationIntent =
    | Readonly<{ kind: 'page'; direction: 'up' | 'down'; bottomFollowIntent: 'user-scroll' }>
    | Readonly<{ kind: 'edge'; edge: 'top' | 'bottom'; bottomFollowIntent: 'user-scroll' | 'pin-bottom' }>
    | Readonly<{ kind: 'message'; direction: 'previous' | 'next'; bottomFollowIntent: 'user-scroll' }>;

function transcriptOwnsFocus(transcriptFocused: boolean, focusOwner: TranscriptFocusOwner): boolean {
    return transcriptFocused === true && focusOwner === 'transcript';
}

export function resolveTranscriptKeyboardNavigationIntent(params: Readonly<{
    key: string;
    shiftKey: boolean;
    transcriptFocused: boolean;
    focusOwner: TranscriptFocusOwner;
    singleKeyShortcutsEnabled: boolean;
}>): TranscriptKeyboardNavigationIntent | null {
    if (!transcriptOwnsFocus(params.transcriptFocused, params.focusOwner)) return null;

    switch (params.key) {
        case 'PageUp':
            return { kind: 'page', direction: 'up', bottomFollowIntent: 'user-scroll' };
        case 'PageDown':
            return { kind: 'page', direction: 'down', bottomFollowIntent: 'user-scroll' };
        case 'Home':
            return { kind: 'edge', edge: 'top', bottomFollowIntent: 'user-scroll' };
        case 'End':
            return { kind: 'edge', edge: 'bottom', bottomFollowIntent: 'pin-bottom' };
        case ' ':
        case 'Spacebar':
            return {
                kind: 'page',
                direction: params.shiftKey ? 'up' : 'down',
                bottomFollowIntent: 'user-scroll',
            };
        default:
            break;
    }

    if (params.singleKeyShortcutsEnabled !== true) return null;
    const normalizedKey = params.key.toLowerCase();
    if (normalizedKey === 'j') {
        return { kind: 'message', direction: 'next', bottomFollowIntent: 'user-scroll' };
    }
    if (normalizedKey === 'k') {
        return { kind: 'message', direction: 'previous', bottomFollowIntent: 'user-scroll' };
    }
    return null;
}

export function moveTranscriptVirtualCursor(params: Readonly<{
    messageIds: readonly string[];
    cursorMessageId: string | null;
    direction: 'previous' | 'next';
}>): Readonly<{ messageId: string; index: number }> | null {
    const messageIds = params.messageIds.filter((id) => id.trim().length > 0);
    if (messageIds.length === 0) return null;

    const cursorIndex = params.cursorMessageId ? messageIds.indexOf(params.cursorMessageId) : -1;
    if (cursorIndex < 0) {
        const fallbackIndex = params.direction === 'previous' ? messageIds.length - 1 : 0;
        const messageId = messageIds[fallbackIndex];
        return messageId ? { messageId, index: fallbackIndex } : null;
    }

    const targetIndex = params.direction === 'previous'
        ? Math.max(0, cursorIndex - 1)
        : Math.min(messageIds.length - 1, cursorIndex + 1);
    const messageId = messageIds[targetIndex];
    return messageId ? { messageId, index: targetIndex } : null;
}
