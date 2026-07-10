import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import { buildKiloAcpEnv } from './callbacks.js';
import { KILO_ACP_STDERR_RULES, KILO_ACP_TIMEOUTS, KILO_ACP_TOOL_NAME_INFERENCE } from './transport.js';

export const KILO_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'kilo',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'kilo',
      args: ['acp'],
    },
    timeouts: KILO_ACP_TIMEOUTS,
  },
  ux: {
    name: 'kilo',
    title: 'Kilo',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
    supportsLoadSession: true,
  },
  sessionIdHeaderName: 'kiloSessionId',
  toolNameInference: KILO_ACP_TOOL_NAME_INFERENCE,
  stderrRules: KILO_ACP_STDERR_RULES,
  permissionOptionSelection: {
    approved: 'allow_always',
  },
  mcp: {
    policy: 'pass_through',
  },
  callbacks: {
    envBuilder: buildKiloAcpEnv,
  },
} satisfies AcpBackendSpecV1);
