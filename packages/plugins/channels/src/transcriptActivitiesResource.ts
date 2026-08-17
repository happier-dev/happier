import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginDynamicResourceInvocationOptionsV1,
  PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { readConversationSessionBindingDeliveryTargets } from './accountLocalBindingPolicy.js';
import { readConversationOutwardDeliveryTranscriptActivities } from './outwardDelivery.js';

export const CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID = 'outward-delivery-activities-v1';

function accountStorageForResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): PluginAccountStorageScope {
  if (options.accountStorage === undefined) {
    throw new PluginError({
      code: 'channels_transcript_activities_resource_account_storage_unavailable',
      message: 'The Channels transcript Activity Resource requires admitted Account storage.',
    });
  }
  return options.accountStorage;
}

function sessionIdForResource(options: PluginDynamicResourceInvocationOptionsV1): string {
  if (options.context.kind !== 'session') {
    throw new PluginError({
      code: 'channels_transcript_activities_resource_session_context_required',
      message: 'The Channels transcript Activity Resource requires a host-stamped Session context.',
    });
  }
  return options.context.sessionId;
}

async function readTranscriptActivitiesResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const accountStorage = accountStorageForResource(options);
  const sessionId = sessionIdForResource(options);
  let bindingTargets;
  try {
    bindingTargets = await readConversationSessionBindingDeliveryTargets({
      collection: accountStorage.collection(CHANNEL_STATE_COLLECTION),
      sessionId,
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof PluginError
      && cause.code === 'channels_binding_session_target_row_invalid') {
      throw new PluginError({
        code: 'channels_transcript_activities_resource_binding_row_invalid',
        message: 'The Channels transcript Activity Resource received an invalid binding row.',
      }, { cause });
    }
    if (cause instanceof PluginError
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
  return JSON.stringify({ version: 1, activities: deliveryActivities.activities });
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
    const accountStorage = accountStorageForResource(options);
    sessionIdForResource(options);
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
