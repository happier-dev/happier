import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { AUGGIE_ACP_TIMEOUTS, AUGGIE_TOOL_NAME_INFERENCE } from './transport.js';

export const AUGGIE_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  timeouts: AUGGIE_ACP_TIMEOUTS,
  toolNameInference: AUGGIE_TOOL_NAME_INFERENCE,
  stderrRules: {
    authenticationErrorDetail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
  },
  mcp: { policy: 'pass_through' },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
