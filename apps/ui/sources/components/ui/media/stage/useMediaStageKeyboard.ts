import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';

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

/** The canonical keyboard provider owns listeners; the open stage supplies only its handlers. */
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
    } : {});
}
