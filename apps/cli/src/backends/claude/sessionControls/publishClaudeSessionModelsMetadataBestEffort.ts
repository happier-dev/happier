import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import { reconcileClaudeSessionModelsState } from '../sessionModels/reconcileClaudeSessionModelsState';
import type { ClaudeInstalledRuntimeCapabilities } from './probeClaudeInstalledRuntimeCapabilities';
import { resolveClaudeSessionModelsState } from './resolveClaudeSessionModelsState';

/** Options that only exist while the installed CLI can apply `--effort`. */
const EFFORT_DEPENDENT_OPTION_IDS = ['reasoning_effort', 'ultracode'] as const;

/**
 * Drop effort-dependent overrides the selected model does not advertise.
 *
 * Hiding the controls from `sessionModelsV1` is not enough: the composer emits whatever overrides
 * are in metadata regardless of which options are advertised, and treats them as non-steerable — so
 * a stale `ultracode` would keep riding later prompts and could push a busy send down the
 * "provider config change refused" path.
 */
function withoutUnsupportedEffortDependentOverrides(
  prev: Metadata,
  supportedOptionIds: ReadonlySet<string>,
): Metadata {
  const unsupportedOptionIds = EFFORT_DEPENDENT_OPTION_IDS.filter((id) => !supportedOptionIds.has(id));
  if (unsupportedOptionIds.length === 0) return prev;

  const next = { ...prev };
  let changed = false;

  for (const key of ['sessionConfigOptionOverridesV1', 'acpConfigOptionOverridesV1'] as const) {
    const state = prev[key];
    const overrides = state?.overrides;
    if (!overrides) continue;
    if (!unsupportedOptionIds.some((id) => id in overrides)) continue;

    const retained = Object.fromEntries(
      Object.entries(overrides).filter(
        ([id]) => !unsupportedOptionIds.includes(id as typeof unsupportedOptionIds[number]),
      ),
    );
    next[key] = { ...state, overrides: retained };
    changed = true;
  }

  return changed ? next : prev;
}

export async function publishClaudeSessionModelsMetadataBestEffort(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  currentModelId: string;
  session: Readonly<{
    ensureMetadataSnapshot: (opts: Readonly<{ timeoutMs: number }>) => Promise<unknown>;
    updateMetadata: (updater: (prev: Metadata) => Metadata) => Promise<void>;
  }>;
  nowMs?: () => number;
  probeInstalledRuntimeCapabilities?: (
    params: Readonly<{ cwd: string; timeoutMs: number }>,
  ) => Promise<ClaudeInstalledRuntimeCapabilities>;
}>): Promise<void> {
  const currentModelId = String(params.currentModelId ?? '').trim();
  if (!currentModelId) return;

  const snapshot = await params.session.ensureMetadataSnapshot({ timeoutMs: 60_000 }).catch(() => null);
  if (!snapshot) return;

  const state = await resolveClaudeSessionModelsState({
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    currentModelId,
    nowMs: params.nowMs ?? (() => Date.now()),
    ...(params.probeInstalledRuntimeCapabilities
      ? { probeInstalledRuntimeCapabilities: params.probeInstalledRuntimeCapabilities }
      : {}),
  }).catch(() => null);
  if (!state) return;

  const selectedModel = state.availableModels.find(
    (model) => model.id === currentModelId || model.extendedContextModelId === currentModelId,
  );
  const selectedModelOptionIds = new Set(
    (selectedModel?.modelOptions ?? []).map((option) => option.id),
  );

  try {
    await params.session.updateMetadata((prev) => {
      const base = withoutUnsupportedEffortDependentOverrides(prev, selectedModelOptionIds);
      const reconciled = reconcileClaudeSessionModelsState({
        metadata: base,
        incomingState: state,
        source: 'catalog',
      });
      return {
        ...base,
        sessionModelsV1: reconciled,
        acpSessionModelsV1: reconciled,
      };
    });
  } catch (error) {
    logger.debug('[claude] Failed to publish session models metadata (non-fatal)', error);
  }
}
