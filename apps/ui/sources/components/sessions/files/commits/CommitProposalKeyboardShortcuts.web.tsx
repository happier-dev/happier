import * as React from 'react';

import { isEditableKeyboardTarget } from '@/components/ui/keyboard/isEditableKeyboardTarget';

export type CommitProposalKeyboardShortcutsProps = Readonly<{
    /** Only while the Commits view is in front, editable, and a change has focus. */
    enabled: boolean;
    /** A commit number (⌥1–⌥9), a new commit after the change's own (⌥N), or Left out (⌥0). */
    onMove: (target: number | 'new' | 'leftOut') => void;
}>;

/**
 * The Commits view's keys (lab WT4-C1): ⌥1–⌥9 move the focused change into that commit, ⌥N into a new commit
 * after its own, ⌥0 leave it out. Option changes the typed character on macOS, so keys are read by code.
 * Never while typing or composing.
 */
export function CommitProposalKeyboardShortcuts(props: CommitProposalKeyboardShortcutsProps) {
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        if (!props.enabled) return;
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing === true) return;
            if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
            if (isEditableKeyboardTarget(event.target)) return;
            const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
            if (digit !== undefined) {
                event.preventDefault();
                latest.current.onMove(digit === '0' ? 'leftOut' : Number(digit));
            } else if (event.code === 'KeyN') {
                event.preventDefault();
                latest.current.onMove('new');
            }
        };
        w.addEventListener('keydown', handler);
        return () => w.removeEventListener('keydown', handler);
    }, [props.enabled]);
    return null;
}
