import * as React from 'react';

import type { SelectedPaneDestinationV1 } from './model/selectedPaneDestination';
import type { DetailsTab } from './model/appPaneReducer';

/** A constrained layout presents the same accepted pane intent in its navigator. */
export type PanePresentationIntent = Readonly<{
    scopeId: string;
}> & (
    | Readonly<{ pane: 'right'; destination: SelectedPaneDestinationV1 | null }>
    | Readonly<{
        pane: 'details';
        tab: DetailsTab;
        /** A contextual start keeps its result in this destination; phones lend it one sheet. */
        start?: boolean;
        /**
         * A page opened from a Details page that this pane does not hold yet. A layout that shows each Details
         * page as its own tab (the phone's tabs rail) opens it there and answers `ownTab`, so the pane never
         * stacks a second tab strip (owner ruling 2026-10-30). The phone's Tabs button asks the same for the page the
         * pane shows, so the Session tab keeps its route (owner ruling 2026-10-31).
         */
        fromDetails?: boolean;
    }>
);

/** `ownTab`: the layout opened the page as its own tab, so the source pane must not take it. */
export type PanePresentation = (intent: PanePresentationIntent) => 'ownTab' | 'startSheet' | void;

const PanePresentationContext = React.createContext<PanePresentation | null>(null);

export const PanePresentationProvider = PanePresentationContext.Provider;

export function usePanePresentation(): PanePresentation | null {
    return React.useContext(PanePresentationContext);
}

/** A transcript with no pane columns keeps Start and its result in its own window, at every width. */
export function DetailsStartSheetHost(props: Readonly<{ children: React.ReactNode }>) {
    const parent = usePanePresentation();
    const present = React.useCallback<PanePresentation>(intent => intent.pane === 'details' && intent.start
        ? 'startSheet' : parent?.(intent), [parent]);
    return React.createElement(PanePresentationProvider, { value: present }, props.children);
}
