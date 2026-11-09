import { useMemo } from 'react';
import { CollectionSpaceSelectionValueV1Schema,
    type CollectionSpaceSelectionV1, type CollectionEntityKindV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createPersistentUiState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';

const selections = createPersistentUiState('collection-space-v1', value => CollectionSpaceSelectionValueV1Schema.parse({ spaceId: value }).spaceId);
const key = (scope: string, entityKind: CollectionEntityKindV1) => JSON.stringify([scope, entityKind]);
const EMPTY_SELECTION: CollectionSpaceSelectionV1 = { v: 1, byAccountScope: {} };

function selectedSpace(scopeKey: string, entityKind: CollectionEntityKindV1, spaceId: string | undefined): CollectionSpaceSelectionV1 {
    return spaceId === undefined ? EMPTY_SELECTION : { v: 1, byAccountScope: { [scopeKey]: { [entityKind]: { spaceId } } } };
}

export function readCollectionSpaceId(scopeKey: string, entityKind: CollectionEntityKindV1): string | undefined {
    return selections.read(key(scopeKey, entityKind));
}

export function readCollectionSpaceSelection(scopeKey: string, entityKind: CollectionEntityKindV1): CollectionSpaceSelectionV1 {
    return selectedSpace(scopeKey, entityKind, readCollectionSpaceId(scopeKey, entityKind));
}

export function useCollectionSpaceSelection(scopeKey: string, entityKind: CollectionEntityKindV1): CollectionSpaceSelectionV1 {
    const spaceId = usePersistentUiStateValue(selections, scopeKey ? key(scopeKey, entityKind) : null);
    return useMemo(() => selectedSpace(scopeKey, entityKind, spaceId), [spaceId, scopeKey, entityKind]);
}

/** Device-local navigation; mounted controls and admitted Actions share this synchronous owner. */
export function selectCollectionSpace(scope: AccountSettingsScope, entityKind: CollectionEntityKindV1, spaceId: string): void {
    selections.set(key(accountSettingsScopeKeySuffix(scope), entityKind), spaceId);
}
