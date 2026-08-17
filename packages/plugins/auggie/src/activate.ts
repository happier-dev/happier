import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createAuggieAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('auggie', createAuggieAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createAuggieAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
