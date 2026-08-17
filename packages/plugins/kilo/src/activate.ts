import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createKiloAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('kilo', createKiloAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createKiloAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
