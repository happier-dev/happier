import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import { normalizeOpenCodeAcpPermissionRulesetMessage } from './permission.js';

export const OPEN_CODE_ACP_BACKEND_SPEC = {
  backendId: 'opencode',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'opencode',
      args: ['acp'],
      env: {
        NODE_ENV: 'production',
        DEBUG: '',
      },
    },
    timeouts: {
      initMs: 60_000,
      toolCallMs: 120_000,
      idleMs: 1_500,
      idleWithoutAssistantMessageMs: 10_000,
    },
    customHandler: {
      onMessage(message, context) {
        if (context.phase !== 'incoming') return 'pass';
        const normalized = normalizeOpenCodeAcpPermissionRulesetMessage(message);
        return normalized === null
          ? 'pass'
          : { kind: 'replace', message: normalized };
      },
    },
  },
  ux: {
    name: 'opencode',
    title: 'OpenCode',
    defaultMode: 'default',
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: 'unknown',
  },
  fsEnabled: true,
  mcp: {
    policy: 'pass_through',
  },
} as const satisfies AcpBackendSpecV1;
