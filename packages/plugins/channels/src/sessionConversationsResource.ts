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
  readConversationBindingManagementRows,
  readConversationConnectionManagementRows,
  type ConversationBindingManagementRow,
} from './accountLocalBindingPolicy.js';
import {
  projectConversationSessionBindingAttentions,
  MAX_CONVERSATION_SESSION_BINDING_ATTENTION_ENTRY_BYTES,
  type ConversationSessionBindingAttentionV1,
} from './sessionBindingAttention.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationOutwardDeliveryTranscriptActivities } from './outwardDelivery.js';
import { MAX_CONVERSATION_BINDINGS_PER_ACCOUNT } from '@happier-dev/channels-protocol/v1';
import {
  requireChannelsResourceAccountStorage,
  requireChannelsResourceSessionId,
} from './requiredAccountStorage.js';

/**
 * The Session projection publishes the SAME management row shape as the
 * Account-wide `bindings-v1` Resource, and in the worst case every one of the
 * 256 Account bindings targets one Session. Its ceiling is therefore that
 * Resource's declared ceiling plus the one attention entry each of those
 * bindings can additionally carry — not a separate estimate and not a round
 * number chosen for headroom.
 */
export const MAX_CHANNELS_SESSION_CONVERSATIONS_BYTES = 212_992
  + (MAX_CONVERSATION_BINDINGS_PER_ACCOUNT * MAX_CONVERSATION_SESSION_BINDING_ATTENTION_ENTRY_BYTES);

/**
 * The Session's own external conversations plus the one attention projection
 * both Composer badges and the Session destination read.
 *
 * `bindings` keeps the exact management-row shape the Account-wide bindings
 * Resource publishes, so the mounted surface still parses and presents it with
 * one parser and one presentation builder. `attention` is a sibling list, not
 * a second binding shape: the badge and the destination therefore name the
 * same conversation for the same reason, from the same bytes.
 */
async function readChannelsSessionConversationsProjection(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<Readonly<{
  bindings: readonly ConversationBindingManagementRow[];
  attention: readonly ConversationSessionBindingAttentionV1[];
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
  if (bindings.length === 0) return { bindings, attention: [] };
  const { connections } = await readConversationConnectionManagementRows({
    collection,
    signal: options.signal,
  });
  return {
    bindings,
    attention: projectConversationSessionBindingAttentions({
      bindings,
      connectionsById: new Map(connections.map((connection) => [connection.connectionId, connection])),
    }),
  };
}

async function readChannelsSessionConversations(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  return JSON.stringify(await readChannelsSessionConversationsProjection(options));
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
  requireChannelsResourceSessionId(options, 'sessionConversations');
  const state = accountStorage.collection(CHANNEL_STATE_COLLECTION);
  const bindingObservation = state.watch({
    index: CHANNEL_STATE_INDEX_ID.byKind,
    prefix: [CHANNEL_STATE_RECORD_KIND.binding],
    order: 'asc',
  }, () => { invalidate(); });
  const connectionObservation = state.watch({
    index: CHANNEL_STATE_INDEX_ID.byKind,
    prefix: [CHANNEL_STATE_RECORD_KIND.connection],
    order: 'asc',
  }, () => { invalidate(); });
  return {
    dispose() {
      bindingObservation.dispose();
      connectionObservation.dispose();
    },
  };
}

/**
 * The chips additionally depend on delivery custody, so they observe the
 * deliveries Collection as well. The list Resource deliberately does not: a
 * delivery attempt changes no binding row it publishes.
 */
function observeChannelsSessionConversations(
  invalidate: () => void,
  options: PluginDynamicResourceInvocationOptionsV1,
) {
  const bindingObservation = observeChannelsSessionBindings(invalidate, options);
  const deliveriesObservation = requireChannelsResourceAccountStorage(options, 'sessionConversations')
    .collection(CHANNEL_DELIVERIES_COLLECTION)
    .watch({ kind: 'collection' }, () => { invalidate(); });
  return {
    dispose() {
      bindingObservation.dispose();
      deliveriesObservation.dispose();
    },
  };
}

/** The Session destination's read-only list of this Session's external conversations. */
export const SESSION_CONVERSATIONS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readChannelsSessionConversations,
  observe: observeChannelsSessionBindings,
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
