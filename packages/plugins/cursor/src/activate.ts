import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { createCursorBackendEngine } from './agent/runtime/engine.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'cursor',
    create: async (ctx) => {
      ctx.logger.debug('[plugins/cursor] Creating backend engine');
      return createCursorBackendEngine(ctx);
    },
  });
}
