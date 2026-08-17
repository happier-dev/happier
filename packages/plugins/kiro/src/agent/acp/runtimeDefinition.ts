import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { KIRO_ACP_STDERR_RULES } from './transport.js';

export const KIRO_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  stderrRules: KIRO_ACP_STDERR_RULES,
  mcp: { policy: 'pass_through' },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
