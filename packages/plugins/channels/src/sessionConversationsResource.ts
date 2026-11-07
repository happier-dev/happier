import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';
import {
  ComposerControlStateV1Schema,
  type ComposerControlStateV1,
} from '@happier-dev/plugin-sdk/ui';

import {
  isChannelStateJsonRecord,
  readConversationBindingManagementRows,
  readConversationConnectionManagementPage,
  type ConversationBindingManagementRow,
} from './accountLocalBindingPolicy.js';
import {
  projectConversationSessionBindingAttentions,
  type ConversationSessionBindingAttentionV1,
} from './sessionBindingAttention.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
} from './collections.js';
import {
  readConversationOutwardDeliveryTranscriptActivities,
  readConversationOutwardDeliveryLastDeliveries,
} from './outwardDelivery.js';
import {
  type ConversationExternalConversationV1,
  ConversationSessionLastDeliveriesV1Schema,
} from '@happier-dev/channels-protocol/v1';
import {
  requireChannelsResourceAccountStorage,
  requireChannelsResourceSessionId,
} from './requiredAccountStorage.js';
import { createConversationSessionProjectionFrontierRowId, readConversationSessionProjectionHistoryGap } from './sessionProjection.js';
import { observeConversationSessionCollections } from './sessionCollectionObservation.js';


/**
 * The Session's own external conversations plus the one attention projection
 * both Composer badges and the Session destination read.
 *
 * `bindings` keeps the exact management-row shape the Account-wide bindings
 * Resource publishes, so the mounted surface still parses and presents it with
 * one parser and one presentation builder. `attention` is a sibling list, not
 * a second binding shape: the badge and the destination therefore name the
 * same conversation for the same reason, from the same bytes. The destination
 * additionally publishes optional `lastDeliveries` from retained custody; the
 * Composer chips retain their existing attention read.
 */
async function readChannelsSessionConversationsProjection(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<Readonly<{
  bindings: readonly ConversationBindingManagementRow[];
  attention: readonly ConversationSessionBindingAttentionV1[];
  externalConversations: readonly ConversationExternalConversationV1[];
}>> {
  const accountStorage = requireChannelsResourceAccountStorage(options, 'sessionConversations');
  const sessionId = requireChannelsResourceSessionId(options, 'sessionConversations');
  const collection = accountStorage.collection(CHANNEL_STATE_COLLECTION);
  let bindings: readonly ConversationBindingManagementRow[];
  try {
    bindings = (await readConversationBindingManagementRows({
      collection,
      signal: options.signal,
      sessionId,
    })).bindings;
  } catch (cause) {
    if (isPluginError(cause) && cause.code === 'channels_binding_management_row_invalid') {
      throw new PluginError({
        code: 'channels_session_conversations_resource_binding_row_invalid',
        message: 'The Channels Session conversations Resource received an invalid binding row.',
      }, { cause });
    }
    if (isPluginError(cause) && cause.code === 'channels_binding_management_page_invalid') {
      throw new PluginError({
        code: 'channels_session_conversations_resource_binding_page_invalid',
        message: 'The Channels Session conversations Resource exceeded the canonical binding bound.',
      }, { cause });
    }
    throw cause;
  }
  if (bindings.length === 0) return { bindings, attention: [], externalConversations: [] };
  const connections = (await Promise.all([...new Set(bindings.map(binding => binding.connectionId))]
    .map(connectionId => readConversationConnectionManagementPage({ collection, connectionId, signal: options.signal }))))
    .flatMap(page => page.connections);
  const connectionsById = new Map(connections.map(connection => [connection.connectionId, connection]));
  const transcriptHistoryGapBindingIds = new Set<string>();
  const transcriptHistoryGapFrontierRevisions = new Map<string, number>();
    for (const row of await Promise.all(bindings.map(binding => collection.get(
      createConversationSessionProjectionFrontierRowId(binding.bindingId), { signal: options.signal },
    )))) {
      if (row === null) continue;
      const value = row.value;
      if (!isChannelStateJsonRecord(value)) continue;
      const payload = value.payload;
      const bindingId = value['binding-id'];
      if (isChannelStateJsonRecord(payload)
        && typeof bindingId === 'string'
        && readConversationSessionProjectionHistoryGap(payload.transcriptCursor) !== null) {
        transcriptHistoryGapBindingIds.add(bindingId);
        transcriptHistoryGapFrontierRevisions.set(bindingId, row.revision);
      }
    }
  return {
    bindings,
    externalConversations: bindings.flatMap(binding => {
      const connection = connectionsById.get(binding.connectionId);
      return connection === undefined ? [] : [{
        bindingId: binding.bindingId,
        providerPluginId: connection.providerPluginId,
        conversationDisplayName: binding.endpoint.label || 'External conversation',
      } satisfies ConversationExternalConversationV1];
    }),
    attention: projectConversationSessionBindingAttentions({
      bindings,
      connectionsById,
      transcriptHistoryGapBindingIds,
      transcriptHistoryGapFrontierRevisions,
    }),
  };
}

async function readChannelsSessionConversations(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const projection = await readChannelsSessionConversationsProjection(options);
  if (projection.bindings.length === 0) return JSON.stringify(projection);
  const deliveries = await readConversationOutwardDeliveryLastDeliveries({
    deliveriesCollection: requireChannelsResourceAccountStorage(options, 'sessionConversations')
      .collection(CHANNEL_DELIVERIES_COLLECTION),
    signal: options.signal,
    bindingTargets: projection.bindings,
  });
  if (deliveries.kind === 'invalid') {
    throw new PluginError({
      code: 'channels_session_conversations_resource_delivery_row_invalid',
      message: 'The Channels Session conversations Resource received an invalid delivery custody row.',
    });
  }
  if (deliveries.kind === 'unavailable') {
    throw new PluginError({
      code: 'channels_session_conversations_resource_delivery_status_unavailable',
      message: 'The Channels Session conversations Resource could not read delivery custody status.',
      retryable: deliveries.reason !== 'cancelled',
    });
  }
  return JSON.stringify({
    ...projection,
    ...(deliveries.lastDeliveries.length === 0 ? {} : {
      lastDeliveries: ConversationSessionLastDeliveriesV1Schema.parse(deliveries.lastDeliveries),
    }),
  });
}

/**
 * The one Session-scoped Channels fact both Composer chips read.
 *
 * `attention` is the SINGLE Session attention model, projected from the
 * canonical binding, connection and delivery owners. It is not a second health
 * state: binding and connection reasons come from
 * `projectConversationSessionBindingAttentions` — the same owner the Session
 * destination renders — and the delivery arm remains the existing
 * transcript-tail projection's terminal-failure phase. Publishing both chips
 * from this one fact is what keeps the badge and the destination from
 * disagreeing about whether this Session needs its owner.
 */
export type ChannelsSessionConversationsFacts = Readonly<{
  conversationCount: number;
  attention: boolean;
}>;

async function readChannelsSessionConversationsFacts(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<ChannelsSessionConversationsFacts> {
  const accountStorage = requireChannelsResourceAccountStorage(options, 'sessionConversations');
  const projection = await readChannelsSessionConversationsProjection(options);
  const bindingTargets = projection.bindings.map((binding) => ({
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
  }));
  if (bindingTargets.length === 0) {
    return { conversationCount: 0, attention: false };
  }
  if (projection.attention.length > 0) {
    // A binding or connection the owner must act on is already decided; the
    // delivery custody read cannot clear it, so do not pay for it.
    return { conversationCount: bindingTargets.length, attention: true };
  }
  const deliveryActivities = await readConversationOutwardDeliveryTranscriptActivities({
    deliveriesCollection: accountStorage.collection(CHANNEL_DELIVERIES_COLLECTION),
    signal: options.signal,
    bindingTargets,
  });
  if (deliveryActivities.kind === 'invalid') {
    throw new PluginError({
      code: 'channels_session_conversations_resource_delivery_row_invalid',
      message: 'The Channels Session conversations Resource received an invalid delivery custody row.',
    });
  }
  if (deliveryActivities.kind === 'unavailable') {
    throw new PluginError({
      code: 'channels_session_conversations_resource_delivery_status_unavailable',
      message: 'The Channels Session conversations Resource could not read delivery custody status.',
      retryable: deliveryActivities.reason !== 'cancelled',
    });
  }
  return {
    conversationCount: bindingTargets.length,
    attention: deliveryActivities.activities.some((activity) => activity.phase === 'failed'),
  };
}

/**
 * The two chips are mutually exclusive by construction, so exactly one Composer
 * control is ever visible for a Session. Presentation text stays in the static
 * manifest declaration, where the host can localize it; only visibility and the
 * conversation count are dynamic.
 */
export function projectChannelsSessionConversationsControlState(
  facts: ChannelsSessionConversationsFacts,
): string {
  const state: ComposerControlStateV1 = {
    visible: facts.conversationCount > 0 && !facts.attention,
    count: facts.conversationCount,
  };
  return JSON.stringify(ComposerControlStateV1Schema.parse(state));
}

export function projectChannelsSessionConversationsAttentionControlState(
  facts: ChannelsSessionConversationsFacts,
): string {
  const state: ComposerControlStateV1 = {
    visible: facts.attention,
    count: facts.conversationCount,
  };
  return JSON.stringify(ComposerControlStateV1Schema.parse(state));
}

function observeChannelsSessionBindings(
  invalidate: () => void,
  options: PluginDynamicResourceInvocationOptionsV1,
) {
  const accountStorage = requireChannelsResourceAccountStorage(options, 'sessionConversations');
  const sessionId = requireChannelsResourceSessionId(options, 'sessionConversations');
  return observeConversationSessionCollections(invalidate, {
    accountStorage, sessionId, signal: options.signal, scope: 'conversations',
  });
}

/**
 * The list and chips depend on delivery custody, so they observe the existing
 * deliveries Collection as well as binding, connection and frontier changes.
 */
function observeChannelsSessionConversations(
  invalidate: () => void,
  options: PluginDynamicResourceInvocationOptionsV1,
) {
  return observeChannelsSessionBindings(invalidate, options);
}

/** The Session destination's read-only list of this Session's external conversations. */
export const SESSION_CONVERSATIONS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readChannelsSessionConversations,
  observe: observeChannelsSessionConversations,
};

/** The connected-conversation chip: visible when this Session is bound and healthy. */
export const SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: async (options) => projectChannelsSessionConversationsControlState(
    await readChannelsSessionConversationsFacts(options),
  ),
  observe: observeChannelsSessionConversations,
};

/** The attention chip: visible only while an outward delivery needs the user. */
export const SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: async (options) => projectChannelsSessionConversationsAttentionControlState(
    await readChannelsSessionConversationsFacts(options),
  ),
  observe: observeChannelsSessionConversations,
};
