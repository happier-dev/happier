import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';

import { buildAuggieAcpArgv } from './callbacks.js';
import { AUGGIE_ACP_TIMEOUTS, AUGGIE_STDERR_RULES, AUGGIE_TOOL_NAME_INFERENCE } from './transport.js';

export const AUGGIE_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'auggie',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'auggie',
      args: ['--acp'],
    },
    timeouts: AUGGIE_ACP_TIMEOUTS,
  },
  ux: {
    name: 'auggie',
    title: 'Auggie',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
  },
  sessionIdHeaderName: 'auggieSessionId',
  toolNameInference: AUGGIE_TOOL_NAME_INFERENCE,
  stderrRules: AUGGIE_STDERR_RULES,
  mcp: {
    policy: 'pass_through',
  },
  callbacks: {
    argvBuilder: buildAuggieAcpArgv,
  },
} satisfies AcpBackendSpecV1);
