import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { INSPECTOR_SELF_CHECK_ACTION_ID } from './manifest.js';

/**
 * A deliberately side-effect-free action used by the reference surface to
 * prove the public declared-action path without creating another dispatcher.
 */
export const runInspectorSelfCheck: ActionHandler = async () => ({ ok: true });

export function activate(api: PluginApi): void {
  api.actions.register(INSPECTOR_SELF_CHECK_ACTION_ID, runInspectorSelfCheck);
}
