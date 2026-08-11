import type { Metadata } from '@/api/types';
import { resolveClaudeModelCatalog } from '@/backends/claude/models/resolveClaudeModelCatalog';

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

  // `--effort` support gates the effort CONTROL, not the model list. Returning null here would
  // leave the new-session picker showing an account-specific list while the running session
  // published none.
  const supportsEffort = /\B--effort\b/i.test(helpText);

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
            ? model.modelOptions.filter((option) => supportsEffort
              || (option.id !== 'reasoning_effort' && option.id !== 'ultracode'))
            : [];
          return modelOptions.length > 0 ? { modelOptions } : {};
        })(),
      };
    }),
  } satisfies ClaudeSessionModelsState;
}
