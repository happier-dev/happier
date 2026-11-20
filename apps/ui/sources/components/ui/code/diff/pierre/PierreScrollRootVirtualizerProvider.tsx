import * as React from 'react';

/** Native diffs never render through Pierre, so there is no scroll root to bind: children pass through. */
export function PierreScrollRootVirtualizerProvider(props: Readonly<{ children: React.ReactNode; getScrollRoot?: () => unknown }>) {
    return <>{props.children}</>;
}

/** Native diffs keep their own windowed list; none windows against an enclosing scroller. */
export function usePierreEnclosingScrollRoot(): boolean {
    return false;
}
