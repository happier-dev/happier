import * as React from 'react';

/**
 * One bottom chrome at a time on a phone: while a page shows its own bottom bar, the page bar wins and the
 * shell's bar folds. Pages report here; the bottom-chrome host reads the answer. Reported as a count, so a
 * page bar replacing another never lets the shell's bar flash back between them.
 */
let reportedPageBars = 0;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

const read = () => reportedPageBars > 0;

/** A page's own bottom bar says it is on screen while it is, and hands the bottom back when it leaves. */
export function useReportPageBarFoldsChrome(active: boolean): void {
    React.useLayoutEffect(() => {
        if (!active) return;
        reportedPageBars += 1;
        notify();
        return () => {
            reportedPageBars -= 1;
            notify();
        };
    }, [active]);
}

export function usePageBarFoldsChrome(): boolean {
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Inside a page's own bottom bar, a phone bar draws only its More, listing every item it would have shown. */
export const CockpitBarFoldedContext = React.createContext(false);
