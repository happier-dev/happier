import * as React from 'react';
import { describeRegistrySourceFailure } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';
import { StoreAppListing, StoreAppListingController } from './StoreAppListing';
import { StoreKindPage } from './StoreKindPage';
import { ListingState } from './StoreListing';
import type { StoreKindSurfaceInput } from './StoreKindSurface';

/** Native App adapter: Registry parsing, preparation, Actions and inventory retain their owners. */
export default function StoreAppKindSurface(props: Readonly<{ input: StoreKindSurfaceInput }>) {
    const input = props.input;
    if (input.mode !== 'listing') return <StoreKindPage kind="app" presented={input.presented} />;
    return <StoreAppListingController key={JSON.stringify(input.selection)} selection={input.selection}>
        {state => {
            const listing = state.listing;
            if (listing && state.lifetime && (listing.kind === 'ready' || listing.kind === 'needs_review')) {
                return <StoreAppListing state={listing} lifetime={state.lifetime} pushed={input.pushed} onClose={input.onClose} />;
            }
            if (!listing || listing.kind === 'loading') return <ListingState kind="loading" size={input.size}
                testID="store.listing.loading" title={t('common.loading')} />;
            return listing.status ? <ListingState kind="error" size={input.size} testID="store.listing.failed"
                title={t('capabilities.store.listing.failed')} body={describeRegistrySourceFailure(listing.status)}
                action={{ label: t('capabilities.store.retry'), onPress: () => { void listing.refresh(); } }} />
                : <ListingState kind="unavailable" size={input.size} testID="store.listing.removed"
                    title={t('capabilities.store.listing.removed')} body={t('capabilities.store.listing.removedBody')} />;
        }}
    </StoreAppListingController>;
}
