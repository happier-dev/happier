import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createKiroAgentRuntime } from './agent/runtime/factory.js';

export function activate(api: PluginApi): void {
  api.agents.register('kiro', createKiroAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createKiroAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
}
