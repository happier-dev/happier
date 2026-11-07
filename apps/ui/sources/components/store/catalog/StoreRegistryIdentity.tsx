import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';

type Identity = Pick<RegistryCatalogItemSummary, 'kind' | 'sourceId' | 'itemId' | 'version' | 'title' | 'brandMark'>;
const identityKey = (item: Pick<Identity, 'kind' | 'sourceId' | 'itemId'>) =>
    JSON.stringify([item.kind, item.sourceId, item.itemId]);
const IdentityContext = React.createContext<ReadonlyMap<string, Identity>>(new Map());

/** Store identity is the admitted listing summary, shared by directory marks and the selected pane. */
export function StoreRegistryIdentityProvider(props: Readonly<{
    items: readonly Identity[];
    children: React.ReactNode;
}>): React.ReactElement {
    const inherited = React.useContext(IdentityContext);
    const identities = React.useMemo(() => {
        if (!props.items.length) return inherited;
        const result = new Map(inherited);
        for (const item of props.items) result.set(identityKey(item), item);
        return result;
    }, [inherited, props.items]);
    return <IdentityContext.Provider value={identities}>{props.children}</IdentityContext.Provider>;
}

export function useStoreRegistryIdentity(reference: MarketplaceCatalogReferenceV1 | null): Identity | null {
    const identities = React.useContext(IdentityContext);
    if (reference?.type !== 'registryItem') return null;
    const identity = identities.get(identityKey(reference));
    // A pinned older listing must not silently borrow the current version's artwork.
    return identity && (!reference.version || !identity.version || reference.version === identity.version) ? identity : null;
}
