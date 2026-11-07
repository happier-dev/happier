import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';

/** Resources consume the Action owner; provider HTTP never runs on this path. */
export function actionResource(actionId: string): PluginDynamicResourceRuntime {
  const ref = { pluginId: 'happier.deploy.supabase', localId: actionId };
  const operands = (options: Parameters<PluginDynamicResourceRuntime['read']>[0]): JsonValue => {
    if (options.context.kind !== 'surface' || options.context.launchInput === undefined) throw new PluginError({ code: 'deployment_invalid' });
    return options.context.launchInput;
  };
  return {
    async read(options) {
      const result = await options.readAction(ref, operands(options), { signal: options.signal });
      if (!result.ok) throw new PluginError({ code: result.errorCode ?? 'deployment_unavailable' });
      return JSON.stringify(result.result);
    },
    // These provider reads are explicit manual snapshots, not a provider push
    // feed. The canonical host refreshes on the next explicit read/remount,
    // including while watched; no unbacked live Action observer is promised.
    observe() { return { dispose() {} }; },
  };
}
