import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

export const QWEN_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  mcp: { policy: 'pass_through' },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
