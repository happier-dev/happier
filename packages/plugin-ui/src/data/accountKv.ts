import { PluginError } from '@happier-dev/plugin-sdk';

import type { PluginUiAccountKv } from './types.js';

/**
 * The one truthful "Account KV cannot be reached from here" scope.
 *
 * A surface realm that has no Account KV path — today the isolated hosted-web
 * renderer, whose host bridge carries Collection UI queries only — reports it
 * with this rather than silently succeeding or growing a second KV path.
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
