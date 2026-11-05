import { TRIAGE_PLUGIN } from './manifest.js';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { createTriageRetainedSessionRelationsUpgrade } from './sessions/retainedSessionRelationsUpgrade.js';

/** The host calls activate once for its captured Account/plugin occurrence and
 * retires its cleanup before replacement. Keep the one upgrade Promise here,
 * not in module state or in a reader that would replay transfer on each demand. */
export function activate(api: PluginAccountApi): () => Promise<void> {
    const upgrade = createTriageRetainedSessionRelationsUpgrade();
    TRIAGE_PLUGIN.activateAccount({
        ...api,
        actions: { register(id, handler, options) {
            api.actions.register(id, (input, context) => {
                const invocation = { ...context, signal: AbortSignal.any([context.signal, upgrade.signal]), sessionRelationsUpgrade: upgrade };
                return handler(input, invocation);
            }, options);
        } },
    });
    return () => upgrade.dispose();
}
