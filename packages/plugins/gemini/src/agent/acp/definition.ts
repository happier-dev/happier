import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import { AGENT_DEFINITION } from '../definition.js';
import { getSuggestedGeminiModelsForUi } from '../models/suggestedModels.js';
import { GEMINI_PERMISSION_MODE_ARGV } from './approvalMode.js';
import { GEMINI_TOOL_NAME_INFERENCE } from './toolNames.js';

export const GEMINI_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'gemini',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'gemini',
      args: ['--acp'],
    },
    timeouts: {
      initMs: 120_000,
      toolCallMs: 120_000,
      investigationToolCallMs: 600_000,
      toolKindTimeouts: {
        think: 30_000,
      },
      idleMs: 500,
    },
  },
  ux: {
    name: 'gemini',
    title: 'Gemini CLI',
    defaultMode: 'default',
    defaultModel: AGENT_DEFINITION.modelConfig.defaultMode,
  },
  capabilities: {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsPromptImages: false,
  },
  auth: {
    methodId: 'gemini-api-key',
  },
  transportLifecycle: {
    initDelayMs: 3_000,
  },
  stderrRules: {
    statusErrors: [
      {
        includes: ['status 404', 'code":404'],
        detail: `Model not found. Suggested models: ${getSuggestedGeminiModelsForUi().join(', ')}`,
      },
    ],
  },
  permissionModeArgv: GEMINI_PERMISSION_MODE_ARGV,
  sessionIdHeaderName: 'geminiSessionId',
  toolNameInference: GEMINI_TOOL_NAME_INFERENCE,
  mcp: {
    policy: 'pass_through',
  },
  callbacks: {},
} satisfies AcpBackendSpecV1);
