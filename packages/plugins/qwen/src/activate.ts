import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createQwenAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('qwen', createQwenAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createQwenAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
