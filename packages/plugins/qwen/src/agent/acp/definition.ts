import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';

import { QWEN_PERMISSION_MODE_ARGV } from './approvalMode.js';

export const QWEN_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'qwen',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'qwen',
      args: ['--acp'],
    },
  },
  ux: {
    name: 'qwen',
    title: 'Qwen Code',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
  },
  permissionModeArgv: QWEN_PERMISSION_MODE_ARGV,
  sessionIdHeaderName: 'qwenSessionId',
  mcp: {
    policy: 'pass_through',
  },
} satisfies AcpBackendSpecV1);
