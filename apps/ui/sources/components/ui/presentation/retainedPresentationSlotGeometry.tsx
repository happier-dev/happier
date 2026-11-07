import * as React from 'react';

import type { RetainedPresentationRect } from './retainedPresentationSlots';

const SlotGeometryContext = React.createContext<Readonly<{
    slotId: string;
    rect: RetainedPresentationRect | null;
}> | null>(null);

/** Project the portal's accepted placement to its retained body without another measurement. */
export function RetainedPresentationSlotGeometryProvider(props: React.PropsWithChildren<Readonly<{
    slotId: string;
    rect: RetainedPresentationRect | null;
}>>): React.ReactElement {
    const value = React.useMemo(() => ({ slotId: props.slotId, rect: props.rect }), [props.slotId, props.rect]);
    return <SlotGeometryContext.Provider value={value}>{props.children}</SlotGeometryContext.Provider>;
}

export function useRetainedPresentationSlotGeometry(slotId: string | undefined): RetainedPresentationRect | null {
    const placement = React.useContext(SlotGeometryContext);
    return placement && placement.slotId === slotId ? placement.rect : null;
}
