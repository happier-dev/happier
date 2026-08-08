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

  const supportsEffort = /\B--effort\b/i.test(helpText);
  if (!supportsEffort) return null;

  const updatedAt = params.nowMs();
  // Same owner as the new-session preflight probe, so the in-session picker cannot disagree about
  // which models exist or which effort tiers they support. Cached per account; falls back to the
  // curated catalog when the Models API is unavailable.
  // No binding needed here: an in-session process already has CLAUDE_CONFIG_DIR pointed at the
  // materialized account, and the catalog keys its cache on that resolved dir.
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
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
          ? { modelOptions: model.modelOptions }
          : {}),
      };
    }),
  } satisfies ClaudeSessionModelsState;
}
