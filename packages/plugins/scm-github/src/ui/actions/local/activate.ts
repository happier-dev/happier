import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { LOCAL_ACT_ACTION_IDS, LocalActRunFormInputV1Schema } from '../../../actions/local/contracts.js';
import { executeLocalActFormIntentV1 } from './mountedForm.js';

/** Client Action artifact only; the Opus-owned form mounts the controller separately. */
export function activate(api: PluginClientApi): void {
  api.actions.register(LOCAL_ACT_ACTION_IDS.form, (input, context) =>
    executeLocalActFormIntentV1(LocalActRunFormInputV1Schema.parse(input), context));
}
