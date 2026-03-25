import { AGENT_MODEL_CONFIG, providers as agentProviders } from '@happier-dev/agents';

import type { PreflightModelsProbeAdapter } from '@/capabilities/probes/preflightModelsProbeAdapterTypes';
import { probeClaudeHelpText } from '@/backends/claude/sessionControls/probeClaudeHelpText';

function shouldAddThinkingModelOption(modelId: string): boolean {
  return agentProviders.claude.isClaudeEffortSupportedModelId(modelId);
}

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
      ...(shouldAddThinkingModelOption(model.id)
        ? (() => {
          const supportsMax = agentProviders.claude.isClaudeEffortMaxSupportedModelId(model.id);
          return {
            modelOptions: [{
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              // Claude defaults to high effort when unset; reflect that as the baseline UI value.
              currentValue: 'high',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                ...(supportsMax ? [{ value: 'max', name: 'Max' }] : []),
              ],
            }],
          };
        })()
        : { modelOptions: undefined }),
    }));
  },
};
