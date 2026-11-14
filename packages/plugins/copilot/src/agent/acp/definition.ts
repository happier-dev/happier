import { STATUS_CODES } from 'node:http';

import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { COPILOT_ACP_STDERR_RULES, COPILOT_ACP_TIMEOUTS, COPILOT_ACP_TOOL_NAME_INFERENCE } from './transport.js';
import { COPILOT_ACP_MODEL_CONTROLS } from './modelControls.js';

export const COPILOT_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  models: COPILOT_ACP_MODEL_CONTROLS,
  sessionUpdates: {
    project: () => null,
    projectOutputDiagnostic(text) {
      // Copilot emits terminal HTTP failures as assistant text and end_turn.
      // Match the complete native diagnostic, never quoted examples or prose.
      const match = /^Error: ([45]\d{2}) ([A-Za-z][A-Za-z ]+)$/.exec(text.trim());
      if (!match) return null;
      const status = Number(match[1]);
      if (STATUS_CODES[status] !== match[2]) return null;
      const providerErrorMessage = `${match[1]} ${match[2]}`;
      return { code: 'acp_turn_failed', severity: 'error', message: text.trim(), details: {
        failureCause: { phase: 'turn', failureReason: 'unclassified_provider_error',
          providerErrorCode: status, providerErrorMessage },
      } };
    },
  },
  timeouts: COPILOT_ACP_TIMEOUTS,
  toolNameInference: COPILOT_ACP_TOOL_NAME_INFERENCE,
  stderrRules: COPILOT_ACP_STDERR_RULES,
  mcp: { policy: 'drop' },
  skills: { sessionDelivery: {
    kind: 'env_path_list', envKey: 'COPILOT_SKILLS_DIRS', separator: ',', value: 'skills_root',
  } },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
