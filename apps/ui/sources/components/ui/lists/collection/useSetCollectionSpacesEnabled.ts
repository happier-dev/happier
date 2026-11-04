import * as React from 'react';
import {
  COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1,
  type CollectionEntityKindV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { useApplySettings } from '@/sync/store/settingsWriters';

/**
 * One list's spaces switch, shared by its title menu and its Manage spaces page. Off turns off only this
 * list. On turns this list on and, when spaces are off for the whole Account, the Account-wide switch too:
 * otherwise "Show spaces" would visibly do nothing.
 */
export function useSetCollectionSpacesEnabled(
  entityKind: CollectionEntityKindV1,
): (next: boolean) => void {
  const applySettings = useApplySettings();
  return React.useCallback(
    (next: boolean) => {
      const listKey = COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1[entityKind];
      applySettings((current) => {
        if (!next) return current[listKey] ? { [listKey]: false } : null;
        const delta = {
          ...(current.collectionSpacesEnabled
            ? {}
            : { collectionSpacesEnabled: true }),
          ...(current[listKey] ? {} : { [listKey]: true }),
        };
        return Object.keys(delta).length ? delta : null;
      });
    },
    [applySettings, entityKind],
  );
}
