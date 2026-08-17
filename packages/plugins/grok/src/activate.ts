import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createGrokAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('grok', createGrokAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createGrokAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
