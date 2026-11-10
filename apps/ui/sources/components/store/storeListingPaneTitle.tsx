import * as React from 'react';

type SetPaneTitle = (title: string | null) => void;

/** The listing host's title slot: a listing that hands its room to another surface names that surface instead. */
export const StoreListingPaneTitleContext = React.createContext<SetPaneTitle | null>(null);

/** A host keeps the override for its current selection only; a new selection starts from the item's own title. */
export function useStoreListingPaneTitleOverride(selectionKey: string | null) {
  const [override, setOverride] = React.useState<Readonly<{ key: string | null; title: string }> | null>(null);
  const set = React.useCallback<SetPaneTitle>(
    (title) => setOverride(title === null ? null : { key: selectionKey, title }),
    [selectionKey],
  );
  return { title: override && override.key === selectionKey ? override.title : null, set };
}

/** While mounted, the surrounding listing pane or page is titled `title`; leaving restores the listing's own. Null leaves it. */
export function useStoreListingPaneTitle(title: string | null) {
  const set = React.useContext(StoreListingPaneTitleContext);
  React.useEffect(() => {
    if (!set || title === null) return;
    set(title);
    return () => set(null);
  }, [set, title]);
}
