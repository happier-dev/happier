import { flushSync } from 'react-dom';

export function commitHomeComposerOpen(open: () => void): void {
    // The browser inserts the first key into the element focused during keydown.
    flushSync(open);
}
