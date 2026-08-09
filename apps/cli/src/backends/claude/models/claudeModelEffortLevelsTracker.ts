import { isCuratedClaudeModelId } from '@/backends/claude/utils/claudeEffort';

import {
  resolveClaudeEffortLevelsFromModelDescriptor,
  resolveClaudeModelCatalog,
} from './resolveClaudeModelCatalog';

/**
 * How long a caller on the message path will wait for a cold catalog.
 *
 * `SessionClient` awaits the user-message callback as part of the pending-queue handoff, so an
 * unbounded wait here would hold the queue behind a network fetch on the first prompt after
 * switching to an uncached model. Past the budget the turn proceeds with no tiers — the same
 * fail-closed state as before — and the resolution continues so the next turn has them.
 */
export const CLAUDE_MODEL_EFFORT_TIER_WAIT_MS = 400;

export type ClaudeModelEffortLevelsTracker = Readonly<{
  /** Resolve the tiers for a newly selected model. Safe to call repeatedly; never throws. */
  refresh: (modelId: unknown) => Promise<void>;
  /**
   * Resolve the tiers, but never block the caller for longer than `waitMs`.
   *
   * Use this on any path that holds up message delivery.
   */
  refreshWithin: (modelId: unknown, waitMs?: number) => Promise<void>;
  /** Tiers for the model `getModelId()` reports, or `[]` when there is no evidence yet. */
  getLevels: () => readonly string[];
  /** The model the current tiers belong to, so callers never apply them to a different model. */
  getModelId: () => string | null;
}>;

/**
 * Tracks the effort tiers reported for the session's current Claude model.
 *
 * The tiers travel on the session mode rather than being read from a cache at spawn or hash time,
 * so launch-option hashing stays a pure function of the mode. Single owner: the two runtime paths
 * in `runClaude` each create one, and previously each carried its own copy of this logic, which
 * let their staleness semantics drift.
 */
export function createClaudeModelEffortLevelsTracker(params: Readonly<{
  resolveTimeoutMs: () => number;
}>): ClaudeModelEffortLevelsTracker {
  let levels: readonly string[] = [];
  let modelId: string | null = null;

  const refresh = async (nextModelId: unknown): Promise<void> => {
    const normalized = typeof nextModelId === 'string' ? nextModelId.trim() : '';
    if (!normalized) {
      // Reset to the CLI default: forget the previous model's tiers rather than leaving them live
      // for whatever is selected next.
      modelId = null;
      levels = [];
      return;
    }
    if (normalized === modelId) return;

    // Drop the previous model's tiers at the transition, not when the lookup returns: a spawn
    // between here and the resolve would otherwise clamp the new model against them.
    modelId = normalized;
    levels = [];

    // Curated models resolve effort from the static table; no catalog lookup needed.
    if (isCuratedClaudeModelId(normalized)) return;

    try {
      const models = await resolveClaudeModelCatalog({ timeoutMs: params.resolveTimeoutMs() });
      // A newer model may have been selected while this lookup was in flight; a late resolve must
      // not publish the previous model's tiers under the current model.
      if (modelId !== normalized) return;
      const model = models.find((candidate) => candidate.id === normalized) ?? null;
      levels = resolveClaudeEffortLevelsFromModelDescriptor(model);
    } catch {
      if (modelId !== normalized) return;
      levels = [];
    }
  };

  const refreshWithin = async (nextModelId: unknown, waitMs = CLAUDE_MODEL_EFFORT_TIER_WAIT_MS): Promise<void> => {
    const resolution = refresh(nextModelId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        resolution,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, waitMs)); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    refresh,
    refreshWithin,
    getLevels: () => levels,
    getModelId: () => modelId,
  };
}
