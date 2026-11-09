import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

import { getSuggestedGeminiModelsForUi } from '../models/suggestedModels.js';
import { GEMINI_TOOL_NAME_INFERENCE } from './toolNames.js';

export const GEMINI_ACP_RUNTIME_DEFINITION = Object.freeze({
  timeouts: {
    initMs: 120_000,
    idleMs: 500,
  },
  stderrRules: {
    statusErrors: [
      {
        includes: ['status 404', 'code":404'],
        detail: `Model not found. Suggested models: ${getSuggestedGeminiModelsForUi().join(', ')}`,
      },
    ],
  },
  toolNameInference: GEMINI_TOOL_NAME_INFERENCE,
  mcp: {
    policy: 'pass_through',
  },
} satisfies AgentAcpRuntimeDefinition);
