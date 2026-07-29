import * as React from 'react';

type MutableRef<T> = { current: T };

export function useCommittedTranscriptProjectionSnapshot<
    TCanonicalItem,
    TDisplayItem,
    TListItem,
    TRenderWindowIndexMap,
>(deps: Readonly<{
    canonicalWindowedItems: readonly TCanonicalItem[];
    canonicalWindowedItemsRef: MutableRef<readonly TCanonicalItem[]>;
    displayItems: readonly TDisplayItem[];
    itemsRef: MutableRef<readonly TDisplayItem[]>;
    listData: readonly TListItem[];
    listDataRef: MutableRef<readonly TListItem[]>;
    renderWindowIndexMap: TRenderWindowIndexMap;
    renderWindowIndexMapRef: MutableRef<TRenderWindowIndexMap>;
}>): void {
    React.useInsertionEffect(() => {
        deps.canonicalWindowedItemsRef.current = deps.canonicalWindowedItems;
        deps.itemsRef.current = deps.displayItems;
        deps.listDataRef.current = deps.listData;
        deps.renderWindowIndexMapRef.current = deps.renderWindowIndexMap;
    }, [
        deps.canonicalWindowedItems,
        deps.canonicalWindowedItemsRef,
        deps.displayItems,
        deps.itemsRef,
        deps.listData,
        deps.listDataRef,
        deps.renderWindowIndexMap,
        deps.renderWindowIndexMapRef,
    ]);
}
