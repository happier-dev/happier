import type { StoryDeckKeyboardShortcutsProps } from './StoryDeckKeyboardShortcuts.web';

/**
 * Native no-op for keyboard shortcuts. The web variant is selected by Metro via
 * the `.web.tsx` extension.
 */
export function StoryDeckKeyboardShortcuts(_props: StoryDeckKeyboardShortcutsProps): null {
    return null;
}

export type { StoryDeckKeyboardShortcutsProps };
