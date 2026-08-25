import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationConnectionManagementRows } from './accountLocalBindingPolicy.js';
import type { ConversationPairingManager } from './pairing.js';
import { requireChannelsResourceAccountStorage } from './requiredAccountStorage.js';

async function readPairingResource(
  pairing: ConversationPairingManager,
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const connectionRows = await readConversationConnectionManagementRows({
    collection: requireChannelsResourceAccountStorage(options, 'pairing').collection(CHANNEL_STATE_COLLECTION),
    signal: options.signal,
  });
  const accountConnectionIds = new Set(connectionRows.connections.map((connection) => connection.connectionId));
  return JSON.stringify(pairing.readManagementProjection(accountConnectionIds));
}

/**
 * The pairing manager remains the sole owner of short-lived challenge and
 * proposal state, including which Account partition each item belongs to. The
 * Account connection index this Resource reads is that partition, and it is
 * handed to the manager instead of being applied to an already-answered
 * whole-daemon projection, so the producer stays the only decision-maker. The
 * generic Resource host owns delivery, currentness, cancellation, and observer
 * lifecycle for the partitioned view.
 */
export function createConversationPairingResourceRuntime(
  pairing: ConversationPairingManager,
): PluginDynamicResourceRuntime {
  return {
    async read(options) {
      return readPairingResource(pairing, options);
    },
    observe(invalidate, options) {
      const accountStorage = requireChannelsResourceAccountStorage(options, 'pairing');
      const pairingObservation = pairing.subscribe(invalidate);
      const connectionObservation = accountStorage.collection(CHANNEL_STATE_COLLECTION).watch({
        index: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection],
        order: 'asc',
      }, invalidate);
      return {
        dispose() {
          pairingObservation.dispose();
          connectionObservation.dispose();
        },
      };
    },
  };
}
