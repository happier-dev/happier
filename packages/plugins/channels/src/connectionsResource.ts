import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_INDEX_ID,
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
) {
  const producer = createConnectionsResourceProducer();
  try {
    return await producer.read(options);
  } finally {
    producer.dispose();
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
      return { ...result, recommendedRecovery };
    });
}

/**
 * The sole normal-management projection of canonical Channel connection rows.
 * The generic Resource owner retains snapshot currentness, Account rebinding,
 * cancellation, generation retirement, byte bounds, and observer lifecycle.
 */
export const CONNECTIONS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readConnectionsResource,
  observe() {
    throw new PluginError({
      code: 'plugin_resource_producer_unavailable',
      message: 'Connections observation requires the host Resource context producer.',
    });
  },
  createProducer: () => createConnectionsResourceProducer(),
};

/** The admitted Resource owns its projection; only changed attention buckets are read again. */
function createConnectionsResourceProducer(): Awaited<ReturnType<NonNullable<PluginDynamicResourceRuntime['createProducer']>>> {
  const connections = new Map<string, ConversationConnectionManagementRow>();
  const dirtyAttention = new Set<string>();
  const deliveryObservations = new Map<string, { dispose(): void }>();
  let invalidate: (() => void) | undefined;
  let metadataDirty = true;
  let stateObservation: { dispose(): void } | undefined;
  let observationStorage: ReturnType<typeof requireChannelsResourceAccountStorage> | undefined;
  const notify = () => { invalidate?.(); };
  const stopObserving = () => {
    invalidate = undefined;
    stateObservation?.dispose();
    stateObservation = undefined;
    observationStorage = undefined;
    for (const observation of deliveryObservations.values()) observation.dispose();
    deliveryObservations.clear();
  };

  function watchAttention(connectionId: string) {
    if (observationStorage === undefined || deliveryObservations.has(connectionId)) return;
    deliveryObservations.set(connectionId, observationStorage.collection(CHANNEL_DELIVERIES_COLLECTION).watch({
      index: CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention,
      prefix: [connectionId, true], order: 'asc',
    }, () => { dirtyAttention.add(connectionId); notify(); }));
  }

  async function readMetadata(options: PluginDynamicResourceInvocationOptionsV1) {
    if (!metadataDirty) return;
    metadataDirty = false;
    const storage = requireChannelsResourceAccountStorage(options, 'connections');
    try {
      const rows = await readConversationConnectionManagementRows({
        collection: storage.collection(CHANNEL_STATE_COLLECTION), signal: options.signal,
      });
      const retained = new Set(rows.connections.map(row => row.connectionId));
      for (const id of connections.keys()) {
        if (retained.has(id)) continue;
        connections.delete(id);
        dirtyAttention.delete(id);
        deliveryObservations.get(id)?.dispose();
        deliveryObservations.delete(id);
      }
      for (const row of rows.connections) {
        const previous = connections.get(row.connectionId);
        if (previous === undefined) dirtyAttention.add(row.connectionId);
        const result = { ...row, attention: { ...row.attention, outwardDelivery: previous?.attention.outwardDelivery } };
        connections.set(row.connectionId, { ...result, recommendedRecovery: recommendConversationConnectionRecovery(result) });
        watchAttention(row.connectionId);
      }
    } catch (error) {
      metadataDirty = true;
      throw error;
    }
  }

  return {
    async read(options) {
      if (invalidate === undefined) {
        connections.clear();
        dirtyAttention.clear();
        metadataDirty = true;
      }
      const access = createChannelsCollectionAccess(requireChannelsResourceAccountStorage(options, 'connections'));
      const boundOptions = { ...options, accountStorage: access.storage };
      try {
        await readMetadata(boundOptions);
        const changed = [...dirtyAttention];
        for (const id of changed) dirtyAttention.delete(id);
        try {
          const projected = await projectConversationConnectionDeliveryAttention({
            connections: changed.flatMap(id => { const row = connections.get(id); return row === undefined ? [] : [row]; }),
            deliveriesCollection: access.storage.collection(CHANNEL_DELIVERIES_COLLECTION), signal: options.signal,
          });
          for (const row of projected) connections.set(row.connectionId, row);
        } catch (error) {
          for (const id of changed) dirtyAttention.add(id);
          throw error;
        }
        return JSON.stringify({ connections: [...connections.values()] });
      } catch (error) {
        if (options.signal.aborted || access.updateRequired === undefined) throw error;
        return JSON.stringify({ status: access.updateRequired });
      }
    },
    observe(onInvalidate, options) {
      invalidate = onInvalidate;
      metadataDirty = true;
      for (const id of connections.keys()) dirtyAttention.add(id);
      const storage = requireChannelsResourceAccountStorage(options, 'connections');
      observationStorage = storage;
      for (const id of connections.keys()) watchAttention(id);
      stateObservation ??= storage.collection(CHANNEL_STATE_COLLECTION).watch({
        index: CHANNEL_STATE_INDEX_ID.byKind, prefix: [CHANNEL_STATE_RECORD_KIND.connection], order: 'asc',
      }, () => { metadataDirty = true; notify(); });
      return { dispose: stopObserving };
    },
    dispose() {
      stopObserving();
      connections.clear();
      dirtyAttention.clear();
    },
  };
}
