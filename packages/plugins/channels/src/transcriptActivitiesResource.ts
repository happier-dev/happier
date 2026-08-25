import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
  PluginTranscriptActivityResourceSnapshotV1,
} from '@happier-dev/plugin-sdk/resources';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationSessionBindingDeliveryTargets } from './accountLocalBindingPolicy.js';
import { readConversationOutwardDeliveryTranscriptActivities } from './outwardDelivery.js';
import {
  requireChannelsResourceAccountStorage,
  requireChannelsResourceSessionId,
} from './requiredAccountStorage.js';

export const CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID = 'outward-delivery-activities-v1';

async function readTranscriptActivitiesResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const accountStorage = requireChannelsResourceAccountStorage(options, 'transcriptActivities');
  const sessionId = requireChannelsResourceSessionId(options, 'transcriptActivities');
  let bindingTargets;
  try {
    bindingTargets = await readConversationSessionBindingDeliveryTargets({
      collection: accountStorage.collection(CHANNEL_STATE_COLLECTION),
      sessionId,
      signal: options.signal,
    });
  } catch (cause) {
    if (isPluginError(cause)
      && cause.code === 'channels_binding_session_target_row_invalid') {
      throw new PluginError({
        code: 'channels_transcript_activities_resource_binding_row_invalid',
        message: 'The Channels transcript Activity Resource received an invalid binding row.',
      }, { cause });
    }
    if (isPluginError(cause)
      && cause.code === 'channels_binding_session_target_page_invalid') {
      throw new PluginError({
        code: 'channels_transcript_activities_resource_binding_page_invalid',
        message: 'The Channels transcript Activity Resource exceeded the canonical binding bound.',
      }, { cause });
    }
    throw cause;
  }
  const deliveryActivities = await readConversationOutwardDeliveryTranscriptActivities({
    deliveriesCollection: accountStorage.collection(CHANNEL_DELIVERIES_COLLECTION),
    signal: options.signal,
    bindingTargets,
  });
  if (deliveryActivities.kind === 'invalid') {
    throw new PluginError({
      code: 'channels_transcript_activities_resource_delivery_row_invalid',
      message: 'The Channels transcript Activity Resource received an invalid delivery custody row.',
    });
  }
  if (deliveryActivities.kind === 'unavailable') {
    throw new PluginError({
      code: 'channels_transcript_activities_resource_delivery_status_unavailable',
      message: 'The Channels transcript Activity Resource could not read delivery custody status.',
      retryable: deliveryActivities.reason !== 'cancelled',
    });
  }
  const snapshot: PluginTranscriptActivityResourceSnapshotV1 = {
    version: 1,
    activities: [...deliveryActivities.activities],
  };
  return JSON.stringify(snapshot);
}

/**
 * The maintained Channels producer for the generic transcript tail. It is a
 * read-only view of existing binding and delivery custody rows; the generic
 * Resource host retains Account rebinding, cancellation, currentness,
 * generation retirement, byte bounds, and observer lifecycle.
 */
export const TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readTranscriptActivitiesResource,
  observe(invalidate, options) {
    const accountStorage = requireChannelsResourceAccountStorage(options, 'transcriptActivities');
    requireChannelsResourceSessionId(options, 'transcriptActivities');
    const bindingObservation = accountStorage.collection(CHANNEL_STATE_COLLECTION).watch({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, () => { invalidate(); });
    const deliveriesObservation = accountStorage.collection(CHANNEL_DELIVERIES_COLLECTION).watch(
      { kind: 'collection' },
      () => { invalidate(); },
    );
    return {
      dispose() {
        bindingObservation.dispose();
        deliveriesObservation.dispose();
      },
    };
  },
};
