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
import { readConversationConnectionManagementRows } from './accountLocalBindingPolicy.js';
import {
  readConversationOutwardDeliveryConnectionAttention,
} from './outwardDelivery.js';
import { requireChannelsResourceAccountStorage } from './requiredAccountStorage.js';

async function readConnectionsResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const accountStorage = requireChannelsResourceAccountStorage(options, 'connections');
  const connectionRows = await readConversationConnectionManagementRows({
    collection: accountStorage.collection(CHANNEL_STATE_COLLECTION),
    signal: options.signal,
  });
  const deliveryAttention = await readConversationOutwardDeliveryConnectionAttention({
    deliveriesCollection: accountStorage.collection(CHANNEL_DELIVERIES_COLLECTION),
    signal: options.signal,
    connectionIds: connectionRows.connections.map((row) => row.connectionId),
  });
  if (deliveryAttention.kind === 'unavailable') {
    throw new PluginError({
      code: 'channels_connections_resource_delivery_status_unavailable',
      message: 'The Channels connections Resource could not read delivery custody status.',
    });
  }

  return JSON.stringify({
    connections: connectionRows.connections.map((connection) => {
      const outwardDelivery = deliveryAttention.attentionByConnection.get(connection.connectionId);
      if (outwardDelivery === undefined) {
        throw new PluginError({
          code: 'channels_connections_resource_delivery_status_invalid',
          message: 'The Channels connections Resource could not derive delivery custody status.',
        });
      }
      return {
        ...connection,
        attention: {
          ...connection.attention,
          outwardDelivery,
        },
      };
    }),
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
    const ingressConflictObservation = accountStorage.collection(CHANNEL_STATE_COLLECTION).watch({
      index: CHANNEL_STATE_INDEX_ID.byAttention,
      prefix: [true],
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
        ingressConflictObservation.dispose();
        deliveriesObservation.dispose();
      },
    };
  },
};
