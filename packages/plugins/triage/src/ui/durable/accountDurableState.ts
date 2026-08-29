import { useMemo } from 'react';
import { usePluginUiDataClientOrNull } from '@happier-dev/plugin-ui/data';

import {
  bindCorpusCollectionsWith,
  type CorpusCollectionsV1,
} from '../../corpus/collections/bindCorpusCollections.js';
import { createTriageAccountKvCatalogStore, type TriageCatalogStoreV1 } from '../../settings/accountKvCatalogStore.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../settings/actions.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../../settings/savedViews.js';

/**
 * What this mount can reach of the reader's durable Account state, directly.
 *
 * Pins, Session links, saved views and configured actions are **Account** state,
 * not provider data. The Account server can be reachable while no daemon is, and
 * when that happens the honest product answer is that the reader's own saved
 * state keeps working while only the provider half goes stale — not that Pin
 * silently stops.
 *
 * A mounted surface already holds an Account-lifetime Data client, so this is a
 * binding and nothing more: the three Collections come from the one corpus
 * binder, and the two catalogs come from the client's own Account KV scope. No
 * identity derivation, codec, CAS rule or encryption decision is restated here,
 * and neither half is cached beyond the client that owns it.
 *
 * `null` on either member is a fact, not a failure mode to work around: this
 * mount cannot reach the Account. Callers fall back to their daemon Action
 * transport — the same domain owner over a different transport — and, if that
 * cannot be reached either, keep the rows already on screen, disable the
 * controls that write, and say so. Nothing is queued, replayed or written
 * speculatively in either direction.
 */

export type TriageDurableAccountV1 = Readonly<{
  /** The three durable Collections, or `null` when the Account is out of reach. */
  collections: CorpusCollectionsV1 | null;
  /** The plugin's saved-view catalog, or `null` for the same reason. */
  savedViews: TriageCatalogStoreV1 | null;
  actions: TriageCatalogStoreV1 | null;
}>;

const UNREACHABLE: TriageDurableAccountV1 = Object.freeze({ collections: null, savedViews: null, actions: null });

export function useTriageDurableAccount(): TriageDurableAccountV1 {
  const client = usePluginUiDataClientOrNull();
  return useMemo(() => client === null ? UNREACHABLE : Object.freeze({
    collections: bindCorpusCollectionsWith((definition) => client.collection(definition)),
    savedViews: createTriageAccountKvCatalogStore(client.accountKv, TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
    actions: createTriageAccountKvCatalogStore(client.accountKv, TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
  }), [client]);
}
