import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime, PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';

const pluginId = 'happier.deploy.neon';
function input(options: PluginDynamicResourceInvocationOptionsV1) {
  if (options.context.kind !== 'surface') throw new PluginError({ code: 'deployment_unavailable' });
  return options.context.launchInput;
}

/** Resources retain their catalog identity; the ordinary qualified Action owner admits each read. */
export function dataResource(localId: string): PluginDynamicResourceRuntime {
  const ref = { pluginId, localId };
  return {
    async read(options) {
      const result = await options.readAction(ref, input(options), { signal: options.signal });
      if (!result.ok) throw new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string'
        ? result.errorCode : 'deployment_unavailable' });
      return JSON.stringify(result.result);
    },
    async observe() {
      // Neon exposes request snapshots here, not provider push. Refresh explicitly through read.
      return { dispose() {} };
    },
  };
}
