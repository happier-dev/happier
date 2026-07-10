import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
  type OpenCodeBrokerProvider,
} from './env.js';
import { ensureOpenCodeBrokerPluginAssets } from './assets.js';
import { verifyOpenCodeBrokerReadyForConnectedSession } from './preflight.js';

export type OpenCodeBrokerPreparation =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: string }>;

/**
 * Live server-launch step for connected OpenCode sessions: write the broker plugin `.js` assets into
 * the (already materialized) isolated `XDG_CONFIG_HOME` config home, then run the fail-closed preflight.
 *
 * For NATIVE sessions (no selection identity) and direct-API-key connected sessions (no brokered
 * provider) it is a strict no-op (`ready: true`). The materializer emits the env; this writes the
 * assets that env references so OpenCode auto-loads the broker from the redirected config home.
 */
export async function prepareOpenCodeBrokerForConnectedSession(
  env: Readonly<Record<string, string | undefined>>,
): Promise<OpenCodeBrokerPreparation> {
  if (typeof env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] !== 'string') {
    return { ready: true };
  }
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const brokeredProviders: OpenCodeBrokerProvider[] = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  const configHomeDir = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '';
  if (brokeredProviders.length > 0 && configHomeDir) {
    await ensureOpenCodeBrokerPluginAssets({
      providers: brokeredProviders,
      connectedConfigHomeDir: configHomeDir,
    });
  }
  return verifyOpenCodeBrokerReadyForConnectedSession(env);
}
