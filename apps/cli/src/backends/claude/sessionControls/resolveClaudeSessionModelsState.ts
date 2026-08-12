import type { Metadata } from '@/api/types';
import { resolveClaudeModelCatalog } from '@/backends/claude/models/resolveClaudeModelCatalog';
import {
  isClaudeModelOptionSupportedByInstalledRuntime,
  probeClaudeInstalledRuntimeCapabilities,
  type ClaudeInstalledRuntimeCapabilities,
} from './probeClaudeInstalledRuntimeCapabilities';

type ClaudeSessionModelsState = NonNullable<Metadata['sessionModelsV1']>;

export async function resolveClaudeSessionModelsState(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  currentModelId: string;
  nowMs: () => number;
  probeInstalledRuntimeCapabilities?: (
    params: Readonly<{ cwd: string; timeoutMs: number }>,
  ) => Promise<ClaudeInstalledRuntimeCapabilities>;
}>): Promise<ClaudeSessionModelsState | null> {
  const installedCapabilities = await (
    params.probeInstalledRuntimeCapabilities ?? probeClaudeInstalledRuntimeCapabilities
  )({ cwd: params.cwd, timeoutMs: params.timeoutMs });

  const updatedAt = params.nowMs();
  // Same owner as the new-session preflight probe, so the in-session picker cannot disagree about
  // which models exist or which effort tiers they support. The catalog owns credential-aware
  // caching and falls back to the curated list when the Models API is unavailable. No binding is
  // needed here: the in-session process already runs with the selected account environment.
  const models = await resolveClaudeModelCatalog({ timeoutMs: params.timeoutMs });

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
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(typeof model.extendedContextModelId === 'string' ? { extendedContextModelId: model.extendedContextModelId } : {}),
        ...(() => {
          const modelOptions = Array.isArray(model.modelOptions)
            ? model.modelOptions.filter((option) =>
              isClaudeModelOptionSupportedByInstalledRuntime(option.id, installedCapabilities))
            : [];
          return modelOptions.length > 0 ? { modelOptions } : {};
        })(),
      };
    }),
  } satisfies ClaudeSessionModelsState;
}
