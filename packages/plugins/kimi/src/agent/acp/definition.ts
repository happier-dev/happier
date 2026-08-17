import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { KIMI_ACP_TIMEOUTS, KIMI_STDERR_RULES, KIMI_TOOL_NAME_INFERENCE } from './transport.js';

export const KIMI_ACP_RUNTIME_DEFINITION = Object.freeze({
  timeouts: KIMI_ACP_TIMEOUTS,
  toolNameInference: KIMI_TOOL_NAME_INFERENCE,
  stderrRules: KIMI_STDERR_RULES,
  mcp: {
    policy: 'drop',
  },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
