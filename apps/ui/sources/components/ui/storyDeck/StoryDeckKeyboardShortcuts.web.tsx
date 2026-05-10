import * as React from 'react';

export type StoryDeckKeyboardShortcutsProps = Readonly<{
    onAdvance: () => void;
    onBack?: () => void;
    onDismiss?: () => void;
}>;

/**
 * Web-only keyboard handler:
 *   - Right / Enter -> advance
 *   - Left          -> back
 *   - Escape        -> dismiss
 */
export function StoryDeckKeyboardShortcuts(props: StoryDeckKeyboardShortcutsProps) {
    React.useEffect(() => {
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;

        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            switch (event.key) {
                case 'ArrowRight':
                case 'Enter':
                    event.preventDefault();
                    props.onAdvance();
                    return;
                case 'ArrowLeft':
                    if (props.onBack) {
                        event.preventDefault();
                        props.onBack();
                    }
                    return;
                case 'Escape':
                    if (props.onDismiss) {
                        event.preventDefault();
                        props.onDismiss();
                    }
                    return;
                default:
                    return;
            }
        };

        w.addEventListener('keydown', handler);
        return () => {
            w.removeEventListener('keydown', handler);
        };
    }, [props.onAdvance, props.onBack, props.onDismiss]);

    return null;
}
