import { useMemo } from 'react';
import { usePluginAccountSettings, usePluginUiDataClientOrNull } from '@happier-dev/plugin-ui/data';
import type { PluginUiAccountSettings } from '@happier-dev/plugin-ui/data';

import {
  bindCorpusCollectionsWith,
  type CorpusCollectionsV1,
} from '../../corpus/collections/bindCorpusCollections.js';

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
 * binder, and Account Settings comes from the client's own Settings scope. No
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

export type TriageAccountSettingsV1 = Pick<PluginUiAccountSettings, 'snapshot' | 'set'>;

export type TriageDurableAccountV1 = Readonly<{
  /** The three durable Collections, or `null` when the Account is out of reach. */
  collections: CorpusCollectionsV1 | null;
  /** The plugin's Account Settings scope, or `null` for the same reason. */
  settings: TriageAccountSettingsV1 | null;
}>;

const UNREACHABLE: TriageDurableAccountV1 = Object.freeze({ collections: null, settings: null });

export function useTriageDurableAccount(): TriageDurableAccountV1 {
  const client = usePluginUiDataClientOrNull();
  const settings = usePluginAccountSettings();
  return useMemo(() => client === null ? UNREACHABLE : Object.freeze({
    collections: bindCorpusCollectionsWith((definition) => client.collection(definition)),
    settings,
  }), [client, settings]);
}
