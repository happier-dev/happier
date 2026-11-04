import * as React from 'react';

import type { RetainedPresentationSlotEntry, RetainedPresentationSlotsStore } from './retainedPresentationSlots';

const RetainedPresentationEntryRetirementContext = React.createContext<(() => void) | null>(null);

/** Borrow removal from the one store, qualified by this rendered entry's existing node identity. */
export function RetainedPresentationEntryLifetime(props: React.PropsWithChildren<Readonly<{
    entry: RetainedPresentationSlotEntry;
    store: RetainedPresentationSlotsStore | null;
}>>): React.ReactElement {
    const { store } = props;
    const { node, slotId } = props.entry;
    const retire = React.useCallback(() => store?.removePortalEntry(slotId, { node }), [node, slotId, store]);
    return <RetainedPresentationEntryRetirementContext.Provider value={retire}>
        {props.children}
    </RetainedPresentationEntryRetirementContext.Provider>;
}

export function useRetainedPresentationEntryRetirement(): (() => void) | null {
    return React.useContext(RetainedPresentationEntryRetirementContext);
}
