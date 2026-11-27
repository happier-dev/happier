import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { CapabilityAddDetailAction, type CapabilityListingConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { StoreItemMark } from './catalog/StoreItemMark';
import { t } from '@/text';

export type StoreStarterListingState = Readonly<{
    config: CapabilityListingConfig<RegistryItemV1>;
    item: RegistryItemV1 | null;
    resolving: boolean;
    error: ReturnType<typeof useRegistryItem>['error'];
    status: ReturnType<typeof useRegistryItem>['status'];
    refresh: ReturnType<typeof useRegistryItem>['refresh'];
}>;

/** The registry owns the read; New app owns using the saved starter. */
export function StoreStarterListing({ reference, children }: Readonly<{
    reference: Extract<MarketplaceCatalogReferenceV1, { type: 'registryItem' }>;
    children: (state: StoreStarterListingState) => React.ReactNode;
}>): React.ReactNode {
    const read = useRegistryItem({ kind: 'starter', sourceId: reference.sourceId, itemId: reference.itemId,
        ...(reference.version ? { version: reference.version } : {}) });
    const openNewApp = useOpenNewApp();
    const config = React.useMemo<CapabilityListingConfig<RegistryItemV1>>(() => ({
        catalog: { itemKey: item => item.summary.itemId },
        renderDetail: item => <><CapabilityDetailHeader title={item.summary.title} purpose={item.summary.description}
            mark={<StoreItemMark facts={{ kind: 'starter', title: item.summary.title }} size={40} />}
            facts={{ extra: [t('capabilities.store.kindWord.starter')] }} testID="store.starter.header" /><CapabilityAddDetailAction /></>,
        detailFooter: item => ({ primary: { label: t('capabilities.store.add'), onPress: async () => {
            openNewApp(item.summary.itemId);
            return null;
        } } }),
        testID: 'store.starter',
    }), [openNewApp]);
    return children({ config, item: read.item, resolving: read.loading, error: read.error, status: read.status, refresh: read.refresh });
}
