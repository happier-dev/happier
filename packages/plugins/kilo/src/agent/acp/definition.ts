import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { KILO_ACP_STDERR_RULES, KILO_ACP_TIMEOUTS, KILO_ACP_TOOL_NAME_INFERENCE } from './transport.js';

export const KILO_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  timeouts: KILO_ACP_TIMEOUTS,
  toolNameInference: KILO_ACP_TOOL_NAME_INFERENCE,
  stderrRules: KILO_ACP_STDERR_RULES,
  mcp: { policy: 'pass_through' },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
