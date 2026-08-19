import * as React from 'react';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import { FlashList, type FlashListPropsCompat, type FlashListRef } from './FlashListCompat';
import type { FlashListCompatComponent } from './resolveFlashListRuntime';
import { LegendListCompat } from './LegendListCompat';

/**
 * The session list's virtualized surface, with its engine selectable.
 *
 * The session list passes an almost entirely standard FlatList surface — of its two engine-specific
 * props, `getItemType` exists on both engines and `overrideProps` is a web DOM escape the adapter
 * spreads — so the engine is genuinely swappable behind one component. This keeps that choice in the
 * list seam instead of the call site, so `SessionsList` does not grow a second decision about which
 * engine it is on.
 *
 * The engine is resolved ONCE per mount, not per render. Reading it per render would make this
 * component's child type follow a live setting, and a changing child type remounts the whole list —
 * discarding measurements, recycling pools and scroll position. A flip therefore takes effect on the
 * next mount, which is what a rollout control should do anyway.
 */
export const SessionListVirtualizedList = React.forwardRef(function SessionListVirtualizedListInner<T>(
    props: FlashListPropsCompat<T>,
    ref: React.ForwardedRef<FlashListRef<T>>,
) {
    const engineRef = React.useRef<'flashList' | 'legendList' | null>(null);
    if (engineRef.current === null) {
        // Resolved from the tuning module rather than the sync facade: this is a leaf list
        // component, and reaching through the app-wide sync object would couple every screen that
        // renders a list to that service being present. `loadSyncTuning` is the canonical resolver
        // and falls back to its own defaults, so the engine choice is well-defined everywhere.
        engineRef.current = loadSyncTuning().sessionListVirtualizedEngine === 'legendList'
            ? 'legendList'
            : 'flashList';
    }

    const Engine = (engineRef.current === 'legendList' ? LegendListCompat : FlashList) as React.ComponentType<
        FlashListPropsCompat<T> & { ref?: React.ForwardedRef<FlashListRef<T>> }
    >;

    return <Engine {...props} ref={ref} />;
    // Typed exactly as the `FlashList` export it stands in for, so swapping the import cannot
    // change how call sites type-check.
}) as unknown as FlashListCompatComponent;
