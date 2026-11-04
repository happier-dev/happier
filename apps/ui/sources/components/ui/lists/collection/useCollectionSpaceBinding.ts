import * as React from 'react';
import {
    resolveCollectionSpacesV1, resolveCollectionSpaceSelectionV1,
    COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1,
    type CollectionEntityKindV1, type CollectionSpacesV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { useAccountSettingsScope, useActiveServerAccountScope, useSetting, useSettingsReady } from '@/sync/domains/state/storage';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useCollectionSpaceSelection } from '@/sync/domains/session/listing/sessionListSpaces';

const EMPTY_COLLECTION_SPACES: CollectionSpacesV1 = { v: 1, spaces: [] };

/** One projection of the existing Account catalog and device selection; the entity retains its own draft. */
export function useCollectionSpaceBinding<K extends CollectionEntityKindV1>(entityKind: K, input: Readonly<{
    scope?: AccountSettingsScope | null;
    defaultName: string;
    defaultFilter: CollectionFilterMapV1[K];
}>) {
    const activeScope = useActiveServerAccountScope();
    const spaceSettingsScope = input.scope === undefined ? activeScope : input.scope;
    const settingsScope = useAccountSettingsScope();
    const settingsReady = useSettingsReady();
    const storedSpaces = useSetting('collectionSpacesV1');
    const masterEnabled = useSetting('collectionSpacesEnabled');
    const listEnabled = useSetting(COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1[entityKind]);
    const spacesReady = spaceSettingsScope !== null && areAccountSettingsScopesEqual(spaceSettingsScope, settingsScope) && settingsReady;
    const spacesEnabled = spacesReady && masterEnabled && listEnabled;
    const spaceAccountScopeKey = spaceSettingsScope ? accountSettingsScopeKeySuffix(spaceSettingsScope) : '';
    const selection = useCollectionSpaceSelection(spaceAccountScopeKey, entityKind);
    const admittedSpaces = spacesReady ? storedSpaces : EMPTY_COLLECTION_SPACES;
    const spaces = React.useMemo(() => resolveCollectionSpacesV1(admittedSpaces, entityKind, {
        name: input.defaultName, filter: input.defaultFilter,
    }), [admittedSpaces, entityKind, input.defaultFilter, input.defaultName]);
    const selectedSpaceId = resolveCollectionSpaceSelectionV1(selection, spaceAccountScopeKey, entityKind, spaces, { authoritative: spacesReady });
    const selectedSpace = spaces.find(space => space.id === selectedSpaceId) ?? null;
    const activeSpace = spacesEnabled ? selectedSpace : null;
    const savedSpace = React.useMemo(() => spaceSettingsScope && activeSpace ? {
        accountScopeKey: spaceAccountScopeKey, id: activeSpace.id, filter: activeSpace.filter,
    } : undefined, [activeSpace, spaceAccountScopeKey, spaceSettingsScope]);
    return { spaces, selectedSpaceId, selectedSpace, activeSpace, spacesEnabled, spacesReady, spaceSettingsScope, spaceAccountScopeKey, admittedSpaces, savedSpace };
}
