import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { createDeepSecExecutionRunFactory } from './agent/reviews/execution.js';

const createDeepSecRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: createDeepSecExecutionRunFactory(),
});

export function activate(api: PluginApi): void {
  api.agents.register('deepsec', createDeepSecRuntime);
}
