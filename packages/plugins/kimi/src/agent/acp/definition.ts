import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';

import { buildKimiAcpArgv, buildKimiAcpEnv } from './callbacks.js';
import { KIMI_ACP_TIMEOUTS, KIMI_STDERR_RULES, KIMI_TOOL_NAME_INFERENCE, resolveKimiAcpToolName } from './transport.js';

export const KIMI_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'kimi',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'kimi',
      args: ['acp'],
    },
    timeouts: KIMI_ACP_TIMEOUTS,
  },
  ux: {
    name: 'kimi',
    title: 'Kimi',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
  },
  sessionIdHeaderName: 'kimiSessionId',
  toolNameInference: KIMI_TOOL_NAME_INFERENCE,
  stderrRules: KIMI_STDERR_RULES,
  mcp: {
    policy: 'drop',
  },
  callbacks: {
    argvBuilder: buildKimiAcpArgv,
    envBuilder: buildKimiAcpEnv,
    toolNameResolver: resolveKimiAcpToolName,
  },
} satisfies AcpBackendSpecV1);
