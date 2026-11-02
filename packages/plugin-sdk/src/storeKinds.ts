import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type { SetSelectionV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import {
    PluginStoreItemReferenceV1ProtocolSchema as canonicalReference,
    PluginStoreItemV1ProtocolSchema as canonicalItem,
    type PluginStoreKindContributionV1,
    type PluginStoreItemReferenceV1,
    type PluginStoreItemV1,
} from '@happier-dev/protocol/plugins/contributions/v2';

export type StoreKindContributionV1 = ReadonlyAuthorDeclaration<PluginStoreKindContributionV1>;
export type { PluginStoreItemReferenceV1, PluginStoreItemV1 };
export const PluginStoreItemReferenceV1ProtocolSchema: ProtocolComposableSchema<PluginStoreItemReferenceV1> = canonicalReference;
export const PluginStoreItemV1ProtocolSchema: ProtocolComposableSchema<PluginStoreItemV1> = canonicalItem;

/** The admitted app view receives qualified Action references through ordinary launch input. */
export type StoreKindLaunchInputV1 = Readonly<{
    store: Readonly<{
        mode: 'browse' | 'listing' | 'installed' | 'search';
        query?: string;
        filters?: Readonly<Record<string, SetSelectionV1<string> | undefined>>;
        selection?: Omit<PluginStoreItemReferenceV1, 'type' | 'kind'>;
        operations: StoreKindContributionV1['operations'];
    }>;
}>;

/** Ordinary UI navigation; the Store route owns selection admission. */
export function createPluginStoreItemHref(reference: PluginStoreItemReferenceV1): string {
    return `/plugins/listing?selection=${encodeURIComponent(JSON.stringify(reference))}`;
}
