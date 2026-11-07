import * as React from 'react';
import { REGISTRY_KINDS_V1, type RegistryKindV1 } from '@happier-dev/protocol/registries';
import type { MarketplaceCatalogDiscoveryV1 } from '@happier-dev/protocol/marketplace';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { StoreRegistryIdentityProvider } from './StoreRegistryIdentity';

const NO_SOURCES: readonly string[] = [];

function SourceIdentities(props: Readonly<{
    kind: RegistryKindV1;
    sourceIds: readonly string[];
    presented: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const listing = useRegistryItems({ kind: props.kind, sourceIds: props.sourceIds }, props.presented && props.sourceIds.length > 0);
    return <StoreRegistryIdentityProvider items={listing.items}>{props.children}</StoreRegistryIdentityProvider>;
}

/** Discover needs summary identity, never the install payload of every visible choice. */
export function StoreDiscoverRegistryIdentityScope(props: Readonly<{
    items: readonly Pick<MarketplaceCatalogDiscoveryV1['items'][number], 'reference' | 'title'>[];
    presented: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const projection = React.useMemo(() => {
        const sources = new Map<RegistryKindV1, string[]>();
        const items = props.items.flatMap(item => {
            const reference = item.reference;
            if (reference.type !== 'registryItem') return [];
            const sourceIds = sources.get(reference.kind) ?? [];
            if (!sourceIds.includes(reference.sourceId)) sourceIds.push(reference.sourceId);
            sources.set(reference.kind, sourceIds);
            return [{ ...reference, title: item.title }];
        });
        return { sources, items };
    }, [props.items]);
    // Keep the leaf topology stable while curation arrives, so an open pane never remounts with its artwork.
    const content = REGISTRY_KINDS_V1.reduceRight<React.ReactNode>((children, kind) =>
        <SourceIdentities key={kind} kind={kind} sourceIds={projection.sources.get(kind) ?? NO_SOURCES}
            presented={props.presented}>{children}</SourceIdentities>, props.children);
    return <StoreRegistryIdentityProvider items={projection.items}>{content}</StoreRegistryIdentityProvider>;
}
