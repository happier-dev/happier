import * as React from 'react';

import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationSlotsProvider,
    type RetainedPresentationSlotsStore,
} from '@/components/ui/presentation/retainedPresentationSlots';
import {
    reconcileBrowserPresentationSlots,
    type BrowserSurfaceLifecycleSnapshot,
} from './browserSurfaceLifecycle';

export type BrowserPresentationRetentionStore = RetainedPresentationSlotsStore & Readonly<{
    recordLifecycle: (slotId: string, snapshot: BrowserSurfaceLifecycleSnapshot) => void;
    isRetained: (slotId: string) => boolean;
}>;

/** Browser lifecycle bookkeeping adapts the shared route-stable source-body portal. */
export function createBrowserPresentationRetentionStore(): BrowserPresentationRetentionStore {
    const portal = createRetainedPresentationSlotsStore();
    const bySlot = new Map<string, Map<string, BrowserSurfaceLifecycleSnapshot>>();
    return {
        ...portal,
        recordLifecycle(slotId, snapshot) {
            const bucket = bySlot.get(slotId);
            if (snapshot.lifecycleState === 'closed') {
                portal.removePortalEntry(slotId);
                if (!bucket) return;
                bucket.delete(snapshot.logicalViewId);
                if (bucket.size === 0) bySlot.delete(slotId);
                return;
            }
            const reconciled = reconcileBrowserPresentationSlots({
                logicalViewId: snapshot.logicalViewId,
                previous: bucket?.get(snapshot.logicalViewId) ?? null,
                nextSlots: Object.values(snapshot.slotsById),
                hostAvailability: 'available',
            });
            // A slot owns only its selected logical view, not a history of every focused tab.
            bySlot.set(slotId, new Map([[snapshot.logicalViewId, reconciled]]));
        },
        isRetained(slotId) {
            return (bySlot.get(slotId)?.size ?? 0) > 0;
        },
    };
}

const BrowserPresentationRetentionContext = React.createContext<BrowserPresentationRetentionStore | null>(null);

/** Mounted outside routes; Browser and Computer consume the same retained presentation map. */
export function BrowserPresentationRetentionProvider(props: React.PropsWithChildren): React.ReactElement {
    const storeRef = React.useRef<BrowserPresentationRetentionStore | null>(null);
    if (storeRef.current === null) storeRef.current = createBrowserPresentationRetentionStore();
    return <BrowserPresentationRetentionContext.Provider value={storeRef.current}>
        <RetainedPresentationSlotsProvider store={storeRef.current}>
            {props.children}
        </RetainedPresentationSlotsProvider>
    </BrowserPresentationRetentionContext.Provider>;
}

export function useOptionalBrowserPresentationRetentionStore(): BrowserPresentationRetentionStore | null {
    return React.useContext(BrowserPresentationRetentionContext);
}
