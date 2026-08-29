import { PluginError } from '@happier-dev/plugin-sdk';

import type { PluginUiAccountKv } from './types.js';

/**
 * The one truthful "Account KV cannot be reached from here" scope.
 *
 * A deliberately partial test or host realm that has no Account KV path
 * reports it with this rather than silently succeeding or growing a second KV
 * implementation. Production hosted web uses the canonical host Data bridge.
 */
export function createUnavailablePluginUiAccountKv(): PluginUiAccountKv {
  const unavailable = async (): Promise<never> => {
    throw new PluginError({
      code: 'plugin_account_storage_unavailable',
      message: 'Plugin Account KV is unavailable in this UI surface realm.',
    });
  };
  return Object.freeze({
    get: unavailable,
    set: unavailable,
    delete: unavailable,
    list: unavailable,
    transaction: unavailable,
  });
}
