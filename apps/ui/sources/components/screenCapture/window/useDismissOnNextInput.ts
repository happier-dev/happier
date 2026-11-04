import * as React from 'react';

/** A callout stays until the next key or press in the window, never on a timer (MIS §5). */
export function useDismissOnNextInput(active: boolean, onInput: () => void): void {
    React.useEffect(() => {
        if (!active) return;
        document.addEventListener('keydown', onInput, true);
        document.addEventListener('pointerdown', onInput, true);
        return () => {
            document.removeEventListener('keydown', onInput, true);
            document.removeEventListener('pointerdown', onInput, true);
        };
    }, [active, onInput]);
}
