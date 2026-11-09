import * as React from 'react';

type RevealTarget = Readonly<{ scrollIntoView?: (options: Readonly<{ block: 'nearest' }>) => void }>;

/**
 * Brings a collection's selected row into view in its scroll column (the Machines list opens on a machine
 * far down a long fleet). Attach the returned ref to the selected row only. It scrolls when the selection
 * changes or when the selected row first exists, never on later re-renders, so the person's own scrolling
 * is left alone. Pass false for a pointer selection that must not move the list. Web hosts only: a host
 * whose row has no `scrollIntoView` ignores it.
 */
export function useRevealSelectedRow<Row = unknown>(selectedKey: string | null, present: boolean, reveal = true): React.RefObject<Row | null> {
    const rowRef = React.useRef<Row | null>(null);
    React.useEffect(() => {
        if (selectedKey === null || !present || !reveal) return;
        (rowRef.current as RevealTarget | null)?.scrollIntoView?.({ block: 'nearest' });
    }, [selectedKey, present, reveal]);
    return rowRef;
}
