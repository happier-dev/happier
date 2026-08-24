import { PluginError } from '@happier-dev/plugin-sdk';

import type { PluginUiAccountSettings } from './types.js';

/**
 * The one truthful "Account Settings cannot be reached from here" scope.
 *
 * A surface realm with no Account Settings path — today the isolated hosted-web
 * renderer, whose host bridge carries Collection UI queries only — reports it
 * with this rather than silently succeeding, returning an empty record that
 * reads as "you configured nothing", or growing a second Settings path.
 */
export function createUnavailablePluginUiAccountSettings(): PluginUiAccountSettings {
  const unavailable = async (): Promise<never> => {
    throw new PluginError({
      code: 'plugin_settings_persistence_unavailable',
      message: 'Plugin Account Settings are unavailable in this UI surface realm.',
      retryable: true,
    });
  };
  return Object.freeze({
    snapshot: unavailable,
    get: unavailable,
    set: unavailable,
    reset: unavailable,
  });
}
