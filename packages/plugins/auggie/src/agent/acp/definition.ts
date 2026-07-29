import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agent-runtime';

import { AUGGIE_ACP_TIMEOUTS, AUGGIE_STDERR_RULES, AUGGIE_TOOL_NAME_INFERENCE } from './transport.js';

export const AUGGIE_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  timeouts: AUGGIE_ACP_TIMEOUTS,
  toolNameInference: AUGGIE_TOOL_NAME_INFERENCE,
  stderrRules: AUGGIE_STDERR_RULES,
  mcp: { policy: 'pass_through' },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
