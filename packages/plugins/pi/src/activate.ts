import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { createPiBackendEngine } from './agent/runtime/engine.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'pi',
    create: createPiBackendEngine,
  });
}
