import { AGENT_MODEL_CONFIG } from '@happier-dev/agents';

import type { PreflightModelsProbeAdapter } from '../../../capabilities/probes/preflightModelsProbeAdapterTypes';
import { probeClaudeHelpText } from '../sessionControls/probeClaudeHelpText';

export const claudePreflightModelsProbeAdapter: PreflightModelsProbeAdapter = {
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs }) => {
    const helpText = await probeClaudeHelpText({ cwd, timeoutMs });
    if (!helpText) return null;

    const supportsEffort = /\B--effort\b/i.test(helpText);
    if (!supportsEffort) return null;

    const models = AGENT_MODEL_CONFIG.claude.staticModels ?? [];
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
        ? { modelOptions: model.modelOptions }
        : { modelOptions: undefined }),
    }));
  },
};
