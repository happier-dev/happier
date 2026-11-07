import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationConnectionManagementRows, type ConversationConnectionManagementRow } from './accountLocalBindingPolicy.js';
import {
  readConversationOutwardDeliveryConnectionAttention,
} from './outwardDelivery.js';
import { requireChannelsResourceAccountStorage } from './requiredAccountStorage.js';
import { recommendConversationConnectionRecovery } from './recoveryRecommendation.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';

async function readConnectionsResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const access = createChannelsCollectionAccess(requireChannelsResourceAccountStorage(options, 'connections'));
  try {
    const connectionRows = await readConversationConnectionManagementRows({
      collection: access.storage.collection(CHANNEL_STATE_COLLECTION),
      signal: options.signal,
    });
    return JSON.stringify({ connections: await projectConversationConnectionDeliveryAttention({
      connections: connectionRows.connections,
      deliveriesCollection: access.storage.collection(CHANNEL_DELIVERIES_COLLECTION), signal: options.signal,
    }) });
  } catch (error) {
    if (options.signal.aborted || access.updateRequired === undefined) throw error;
    // No rows are claimed when this reader's compiled contract is behind.
    // The existing management Resource carries the update remedy, including
    // when a custody adapter reduced the refusal to generic unavailability.
    return JSON.stringify({ status: access.updateRequired });
  }
}

/** Resource snapshots and management pages share the same custody-status projection. */
export async function projectConversationConnectionDeliveryAttention(input: Readonly<{
  connections: readonly ConversationConnectionManagementRow[];
  deliveriesCollection: Parameters<typeof readConversationOutwardDeliveryConnectionAttention>[0]['deliveriesCollection'];
  signal: AbortSignal;
}>) {
  const deliveryAttention = await readConversationOutwardDeliveryConnectionAttention({
    deliveriesCollection: input.deliveriesCollection,
    signal: input.signal,
    connectionIds: input.connections.map((row) => row.connectionId),
  });
  if (deliveryAttention.kind === 'unavailable') {
    throw new PluginError({
      code: 'channels_connections_resource_delivery_status_unavailable',
      message: 'The Channels connections Resource could not read delivery custody status.',
    });
  }

  return input.connections.map((connection) => {
      const outwardDelivery = deliveryAttention.attentionByConnection.get(connection.connectionId);
      if (outwardDelivery === undefined) {
        throw new PluginError({
          code: 'channels_connections_resource_delivery_status_invalid',
          message: 'The Channels connections Resource could not derive delivery custody status.',
        });
      }
      const result = {
        ...connection,
        attention: {
          ...connection.attention,
          outwardDelivery,
        },
      };
      const recommendedRecovery = recommendConversationConnectionRecovery(result);
      return { ...result, ...(recommendedRecovery === null ? {} : { recommendedRecovery }) };
    });
}

/**
 * The sole normal-management projection of canonical Channel connection rows.
 * The generic Resource owner retains snapshot currentness, Account rebinding,
 * cancellation, generation retirement, byte bounds, and observer lifecycle.
 */
export const CONNECTIONS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readConnectionsResource,
  observe(invalidate, options) {
    const accountStorage = requireChannelsResourceAccountStorage(options, 'connections');
    const stateObservation = accountStorage.collection(CHANNEL_STATE_COLLECTION).watch({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
    }, () => { invalidate(); });
    // Delivery custody is the existing status source for retry/partial/unknown
    // attention. Watch its Collection directly; the Resource host still owns
    // coalescing, currentness, and the subsequent snapshot reread.
    const deliveriesObservation = accountStorage.collection(CHANNEL_DELIVERIES_COLLECTION).watch(
      { kind: 'collection' },
      () => { invalidate(); },
    );
    return {
      dispose() {
        stateObservation.dispose();
        deliveriesObservation.dispose();
      },
    };
  },
};
