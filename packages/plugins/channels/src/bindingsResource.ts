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
import { readConversationBindingManagementRows } from './accountLocalBindingPolicy.js';

function accountStorageForResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): PluginAccountStorageScope {
  if (options.accountStorage === undefined) {
    throw new PluginError({
      code: 'channels_bindings_resource_account_storage_unavailable',
      message: 'The Channels bindings Resource requires admitted Account storage.',
    });
  }
  return options.accountStorage;
}

async function readBindingsResource(
  options: PluginDynamicResourceInvocationOptionsV1,
): Promise<string> {
  const collection = accountStorageForResource(options).collection(CHANNEL_STATE_COLLECTION);
  try {
    return JSON.stringify(await readConversationBindingManagementRows({
      collection,
      signal: options.signal,
    }));
  } catch (cause) {
    if (cause instanceof PluginError && cause.code === 'channels_binding_management_row_invalid') {
      throw new PluginError({
        code: 'channels_bindings_resource_binding_row_invalid',
        message: 'The Channels bindings Resource received an invalid binding row.',
      }, { cause });
    }
    if (cause instanceof PluginError && cause.code === 'channels_binding_management_page_invalid') {
      throw new PluginError({
        code: 'channels_bindings_resource_binding_page_invalid',
        message: 'The Channels bindings Resource exceeded the canonical binding bound.',
      }, { cause });
    }
    throw cause;
  }
}

/**
 * The sole normal-management projection of canonical Channel binding rows.
 * The generic Resource owner retains snapshot currentness, Account rebinding,
 * cancellation, generation retirement, byte bounds, and observer lifecycle.
 */
export const BINDINGS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  read: readBindingsResource,
  observe(invalidate, options) {
    const observation = accountStorageForResource(options).collection(CHANNEL_STATE_COLLECTION).watch({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, () => { invalidate(); });
    return {
      dispose() {
        observation.dispose();
      },
    };
  },
};
