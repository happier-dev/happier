import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';

const STAGE_OWNS_KEYS = Object.freeze({ ownsKeys: true });

export type MediaStageKeyboardActions = Readonly<{
    previous: () => void;
    next: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    fit: () => void;
    actualSize: () => void;
    playPause?: () => void;
    annotate?: () => void;
}>;

/**
 * The canonical keyboard provider owns listeners; the open stage supplies only its handlers. The open stage owns
 * its keys (← → walk, zoom, play) while it is open, so the app-wide shortcut opt-ins don't gate them here; a Files
 * tab player registering the same commands stays gated.
 */
export function useMediaStageKeyboard(actions: MediaStageKeyboardActions | null): void {
    useKeyboardShortcutHandlers(actions ? {
        'media.previous': actions.previous,
        'media.next': actions.next,
        'media.zoomIn': actions.zoomIn,
        'media.zoomOut': actions.zoomOut,
        'media.fit': actions.fit,
        'media.actualSize': actions.actualSize,
        ...(actions.playPause ? { 'media.playPause': actions.playPause } : {}),
        ...(actions.annotate ? { 'media.annotate': actions.annotate } : {}),
    } : {}, undefined, STAGE_OWNS_KEYS);
}
