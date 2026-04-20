import { AGENT_MODEL_CONFIG } from '@happier-dev/agents';

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
      return {
        id: model.id,
        name: model.name,
        ...(description ? { description } : {}),
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
          ? { modelOptions: model.modelOptions }
          : {}),
      };
    }),
  } satisfies ClaudeSessionModelsState;
}
