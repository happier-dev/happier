import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { CapabilityAddDetailAction, type CapabilityListingConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { StoreItemMark } from './catalog/StoreItemMark';
import { t } from '@/text';

/** The registry owns the read; New app owns using the saved starter. */
export function useStoreStarterListing(reference: MarketplaceCatalogReferenceV1) {
    const selected = reference.type === 'registryItem' && reference.kind === 'starter' ? reference : null;
    const read = useRegistryItem({ kind: 'starter', sourceId: selected?.sourceId ?? '', itemId: selected?.itemId ?? '',
        ...(selected?.version ? { version: selected.version } : {}) }, selected !== null);
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
    return { config, item: read.item, resolving: read.loading, error: read.error, status: read.status, refresh: read.refresh };
}
