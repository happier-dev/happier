import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createCopilotAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('copilot', createCopilotAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createCopilotAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
