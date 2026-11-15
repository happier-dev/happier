import * as React from 'react';

import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';

// Kept apart from the focus boundary so shared page chrome can read its region without loading the Destination host graph.
/** The pane column a surface is drawn in: main content, the side column, or Details itself. */
export type PaneRegion = DetailsOpenerRegion | 'details';

const PaneRegionContext = React.createContext<PaneRegion | null>(null);

/**
 * Set by the pane geometry owner around each column, so opening Details records where it was opened
 * from without every caller naming its region.
 */
export function PaneRegionProvider(props: Readonly<{ region: PaneRegion | null; children: React.ReactNode }>) {
    return <PaneRegionContext.Provider value={props.region}>{props.children}</PaneRegionContext.Provider>;
}

/** `null` outside a pane column host (a full-screen route). */
export function usePaneRegion(): PaneRegion | null {
    return React.useContext(PaneRegionContext);
}
