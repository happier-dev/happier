import type { PluginApi } from '@happier-dev/plugin-sdk';

import { createCursorAgentRuntime } from './agent/runtime/engine.js';

export function activate(api: PluginApi): void {
  api.agents.register('cursor', createCursorAgentRuntime);
}
