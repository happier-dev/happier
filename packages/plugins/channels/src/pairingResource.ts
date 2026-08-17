import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationConnectionManagementRows } from './accountLocalBindingPolicy.js';
import type { ConversationPairingManager } from './pairing.js';

function accountStorageForResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): PluginAccountStorageScope {
  if (options.accountStorage === undefined) {
    throw new PluginError({
      code: 'channels_pairing_resource_account_storage_unavailable',
      message: 'The Channels pairing Resource requires admitted Account storage.',
    });
  }
  return options.accountStorage;
}

async function readPairingResource(
  pairing: ConversationPairingManager,
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const connectionRows = await readConversationConnectionManagementRows({
    collection: accountStorageForResource(options).collection(CHANNEL_STATE_COLLECTION),
    signal: options.signal,
  });
  const accountConnectionIds = new Set(connectionRows.connections.map((connection) => connection.connectionId));
  const projection = pairing.readManagementProjection();
  return JSON.stringify({
    ...projection,
    challenges: projection.challenges.filter((challenge) => accountConnectionIds.has(challenge.connectionId)),
    proposals: projection.proposals.filter((proposal) => accountConnectionIds.has(proposal.connectionId)),
  });
}

/**
 * The pairing manager remains the sole owner of short-lived challenge and
 * proposal state. The Account connection index is the authorization boundary
 * for its global daemon projection; the generic Resource host owns delivery,
 * currentness, cancellation, and observer lifecycle for that filtered view.
 */
export function createConversationPairingResourceRuntime(
  pairing: ConversationPairingManager,
): PluginDynamicResourceRuntime {
  return {
    async read(options) {
      return readPairingResource(pairing, options);
    },
    observe(invalidate, options) {
      const accountStorage = accountStorageForResource(options);
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
