import { AGENT_MODEL_CONFIG, providers as agentProviders } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';

type ClaudeSessionModelsState = NonNullable<Metadata['sessionModelsV1']>;

export async function resolveClaudeSessionModelsState(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  currentModelId: string;
  nowMs: () => number;
  probeHelpText: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<ClaudeSessionModelsState | null> {
  const helpText = await params.probeHelpText({ cwd: params.cwd, timeoutMs: params.timeoutMs });
  if (!helpText) return null;

  const supportsEffort = /\B--effort\b/i.test(helpText);
  if (!supportsEffort) return null;

  const updatedAt = params.nowMs();
  const models = AGENT_MODEL_CONFIG.claude.staticModels ?? [];

  return {
    v: 1,
    provider: 'claude',
    updatedAt,
    currentModelId: params.currentModelId,
    availableModels: models.map((model) => {
      const description = typeof model.description === 'string' ? model.description : '';
      const supportsThinking = agentProviders.claude.isClaudeEffortSupportedModelId(model.id);
      const supportsMax = supportsThinking && agentProviders.claude.isClaudeEffortMaxSupportedModelId(model.id);

      return {
        id: model.id,
        name: model.name,
        ...(description ? { description } : {}),
        ...(supportsThinking
          ? {
              modelOptions: [
                {
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
                },
              ],
            }
          : {}),
      };
    }),
  } satisfies ClaudeSessionModelsState;
}
