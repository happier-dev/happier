import * as React from 'react';

import { isEditableKeyboardTarget } from '@/components/ui/keyboard/isEditableKeyboardTarget';

export type WalkthroughKeyboardShortcutsProps = Readonly<{
    /** Only while the Walkthrough is on screen and in front. */
    enabled: boolean;
    onMove: (direction: 1 | -1) => void;
    onToggleReviewed?: () => void;
    onAsk?: () => void;
}>;

/**
 * The Walkthrough's keys (lab WT1-A): J / K next and previous stop, immediately; R the person's explicit
 * reviewed toggle on the current stop; / asks about it. Never while typing, composing or with a modifier.
 */
export function WalkthroughKeyboardShortcuts(props: WalkthroughKeyboardShortcutsProps) {
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        if (!props.enabled) return;
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing === true) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (isEditableKeyboardTarget(event.target)) return;
            const current = latest.current;
            const key = event.key.toLowerCase();
            if (key === 'j' || key === 'k') {
                event.preventDefault();
                current.onMove(key === 'j' ? 1 : -1);
            } else if (key === 'r' && current.onToggleReviewed) {
                event.preventDefault();
                current.onToggleReviewed();
            } else if (event.key === '/' && current.onAsk) {
                event.preventDefault();
                current.onAsk();
            }
        };
        w.addEventListener('keydown', handler);
        return () => w.removeEventListener('keydown', handler);
    }, [props.enabled]);
    return null;
}
