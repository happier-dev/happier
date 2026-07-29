import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';

import { createCodeRabbitExecutionRunFactory } from './agent/reviews/nativeRun.js';

const createCodeRabbitRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: createCodeRabbitExecutionRunFactory(),
});

export function activate(api: PluginApi): void {
  api.agents.register('coderabbit', createCodeRabbitRuntime);
}
