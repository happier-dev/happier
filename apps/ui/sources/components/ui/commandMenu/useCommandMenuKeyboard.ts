import * as React from 'react';

/**
 * Returns a stable `handleKey(event)` that returns `true` if the key was consumed.
 * Wired by hosts inside their existing `handleKeyPress` so the host preserves precedence.
 * Recognises exactly the existing AgentInput autocomplete key contract:
 * ArrowUp/Down (wraps), Enter, Tab (no-shift = select), Escape (close).
 * Shift+Tab returns false so the host can run its existing permission-mode shortcut.
 */
export function useCommandMenuKeyboard(input: Readonly<{
    open: boolean;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onSelect: () => void;
    onClose: () => void;
}>): { handleKey: (event: { key: string; shiftKey?: boolean }) => boolean } {
    const { open, onMoveUp, onMoveDown, onSelect, onClose } = input;

    const handleKey = React.useCallback(
        (event: { key: string; shiftKey?: boolean }): boolean => {
            if (!open) return false;

            switch (event.key) {
                case 'ArrowDown':
                    onMoveDown();
                    return true;
                case 'ArrowUp':
                    onMoveUp();
                    return true;
                case 'Enter':
                    onSelect();
                    return true;
                case 'Tab':
                    if (event.shiftKey) return false;
                    onSelect();
                    return true;
                case 'Escape':
                    onClose();
                    return true;
                default:
                    return false;
            }
        },
        [open, onMoveUp, onMoveDown, onSelect, onClose],
    );

    return React.useMemo(() => ({ handleKey }), [handleKey]);
}
