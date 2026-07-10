import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import { buildCopilotAcpArgv } from './callbacks.js';
import { COPILOT_ACP_STDERR_RULES, COPILOT_ACP_TIMEOUTS, COPILOT_ACP_TOOL_NAME_INFERENCE } from './transport.js';

export const COPILOT_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'copilot',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'copilot',
      args: ['--acp'],
    },
    timeouts: COPILOT_ACP_TIMEOUTS,
  },
  ux: {
    name: 'copilot',
    title: 'GitHub Copilot',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
    supportsLoadSession: true,
  },
  sessionIdHeaderName: 'copilotSessionId',
  toolNameInference: COPILOT_ACP_TOOL_NAME_INFERENCE,
  stderrRules: COPILOT_ACP_STDERR_RULES,
  mcp: {
    policy: 'pass_through',
  },
  callbacks: {
    argvBuilder: buildCopilotAcpArgv,
  },
} satisfies AcpBackendSpecV1);
