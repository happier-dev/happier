import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';
import { mergeSessionWorkStateMetadataV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY,
} from '../../../transcripts/goalStatus.js';
import {
  createClaudeGoalWorkStateSource,
  type ClaudeGoalWorkStateSource,
} from '../../../transcripts/goalSource.js';
import { buildClaudeGoalCommand } from '../../goalControl/command.js';

/**
 * Centralized native `/goal` runtime for the Claude unified terminal.
 *
 * This single module owns BOTH halves of the goal feature on the live path so
 * the goal wiring is never scattered (the H6 lesson):
 *
 *  - SOURCE: `source.observeTranscriptMessage(row)` is wired into the provider
 *    transcript follow loop's `onObserveRow`, turning `goal_status` attachments +
 *    the system-init `slash_commands` into a published `kind:'goal'` work-state
 *    item. Publishes through a merge-safe metadata update so it coexists with the
 *    todo/task families the outbound dispatch facet derives.
 *  - EFFECTOR: `setGoal`/`clearGoal` inject a literal `/goal …` user turn into the
 *    running TUI (via the supplied `injectGoalCommand`). The `goal_status`
 *    attachment Claude then emits is the single SOURCE OF TRUTH — the effector
 *    never writes goal state into metadata itself.
 */

type GoalControlError = Readonly<{ ok: false; errorCode: string; error: string }>;

function stableError(errorCode: string): GoalControlError {
  return { ok: false, errorCode, error: errorCode };
}

/** Read-modify-write metadata update (the host's merge-safe write seam). */
export type ClaudeGoalMetadataUpdate = (request: Readonly<{
  kind: 'update';
  handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  reason?: string;
}>) => Promise<void>;

export type ClaudeGoalCommandDelivery =
  | Readonly<{ kind: 'queued' }>
  | Readonly<{ kind: 'sent-to-terminal' }>
  | Readonly<{ kind: 'provider-turn-started' }>;

/** Injects a `/goal …` command into the unified terminal as a user turn. */
export type ClaudeGoalCommandInjector = (message: string) => Promise<void | ClaudeGoalCommandDelivery>;

export type ClaudeUnifiedGoalRuntime = Readonly<{
  /** The transcript goal source — wire `observeTranscriptMessage` into `onObserveRow`. */
  source: ClaudeGoalWorkStateSource;
  /**
   * ACTIVE-session goal effector. Injects `/goal <objective>` as a user turn.
   * Returns a typed non-fallback error on empty objective / inject failure so the
   * live RPC reports cleanly instead of throwing (which the goal router would
   * treat as a fallback trigger and seed a decorative metadata goal).
   */
  setGoal: (
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ) => Promise<unknown>;
  clearGoal: () => Promise<unknown>;
}>;

const DELIVERY_RANK: Record<ClaudeGoalCommandDelivery['kind'], number> = {
  queued: 0,
  'sent-to-terminal': 1,
  'provider-turn-started': 2,
};

const ACCEPTED_DELIVERY_THRESHOLD = DELIVERY_RANK['sent-to-terminal'];

function reachedAcceptedThreshold(delivery: void | ClaudeGoalCommandDelivery): boolean {
  if (delivery === undefined) return true;
  return DELIVERY_RANK[delivery.kind] >= ACCEPTED_DELIVERY_THRESHOLD;
}

/**
 * G-1/G-2: Claude's `/goal` command carries an objective ONLY — it cannot enforce a token budget or
 * apply a status transition (pause/complete/…). Requesting either (a `tokenBudget` field, even
 * `null` which is a request to CLEAR the budget, or a `status` transition) is UNSUPPORTED on the
 * Claude live-RPC path. `objective`-only sets are the sole supported mutation and pass through.
 */
function requestsUnsupportedGoalOption(
  options: Readonly<{ status?: string; tokenBudget?: number | null }> | undefined,
): boolean {
  if (!options) return false;
  if (options.tokenBudget !== undefined) return true;
  if (options.status !== undefined) return true;
  return false;
}

export function createClaudeUnifiedGoalRuntime(params: Readonly<{
  backendId: string;
  agentId?: string;
  getCurrentClaudeSessionId: () => string | null;
  writeMetadataUpdate?: ClaudeGoalMetadataUpdate;
  publishWorkStateSnapshot?: (snapshot: SessionWorkStateV1) => void;
  injectGoalCommand: ClaudeGoalCommandInjector;
  logError?: (message: string, error: unknown) => void;
}>): ClaudeUnifiedGoalRuntime {
  const publishWorkStateSnapshot = (snapshot: SessionWorkStateV1): void => {
    if (params.publishWorkStateSnapshot) {
      params.publishWorkStateSnapshot(snapshot);
      return;
    }
    if (!params.writeMetadataUpdate) {
      params.logError?.('failed to publish Claude goal work-state snapshot (non-fatal)', new Error('goal work-state publisher unavailable'));
      return;
    }
    void params.writeMetadataUpdate({
      kind: 'update',
      // The merge chokepoint resolves `primaryItemId` canonically over the MERGED
      // item set (shared `resolveSessionWorkStatePrimaryItemId`), preserving a
      // still-present active task/todo primary so the goal source never steals
      // primacy (MED-2). No runtime-local primary preservation step.
      handler: (current) => mergeSessionWorkStateMetadataV1({
        metadata: current,
        nextOwned: snapshot,
        ownedItemIds: [CLAUDE_GOAL_WORK_STATE_ITEM_ID],
        ownedSourceFamilies: [CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY],
      }),
      reason: 'claude_goal_work_state',
    }).catch((error) => {
      params.logError?.('failed to publish Claude goal work-state snapshot (non-fatal)', error);
    });
  };

  const source = createClaudeGoalWorkStateSource({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    publishWorkStateSnapshot,
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
    ...(params.logError ? { logError: params.logError } : {}),
  });

  return {
    source,
    setGoal: async (objective, options) => {
      if (requestsUnsupportedGoalOption(options)) {
        // Fail loudly BEFORE injecting: a budget/status mutation cannot be delivered via `/goal`, so
        // pretending it succeeded (or injecting an objective-only command that silently drops it)
        // would leave metadata/runtime disagreeing (G-1/G-2). The errorCode is absent from the goal
        // router's fallback set, so the live RPC reports cleanly instead of seeding a decorative goal.
        return stableError('session_goal_control_unsupported');
      }
      const trimmed = typeof objective === 'string' ? objective.trim() : '';
      if (!trimmed) {
        // Claude `/goal` cannot pursue an empty objective. A non-fallback error
        // keeps the router on the live path and surfaces the failure cleanly.
        return stableError('session_goal_control_objective_required');
      }
      let delivery: void | ClaudeGoalCommandDelivery;
      try {
        delivery = await params.injectGoalCommand(buildClaudeGoalCommand({ type: 'set', objective: trimmed }));
      } catch {
        return stableError('session_goal_control_inject_failed');
      }
      if (!reachedAcceptedThreshold(delivery)) {
        return stableError('session_goal_control_inject_failed');
      }
      // Record the SET epoch once the `/goal <objective>` inject has been delivered, BEFORE any
      // provider `goal_status`, so re-setting the SAME objective after a clear is accepted instead of
      // being suppressed as a stale post-clear replay (G2/QA-CHIP-4). Best-effort: a failure here must
      // not fail the set itself (the `/goal` was already injected).
      try {
        source.recordGoalSetIntent();
      } catch {
        // Non-fatal: the `/goal` was sent; the epoch nudge is a best-effort suppression lift.
      }
      return undefined;
    },
    clearGoal: async () => {
      let delivery: void | ClaudeGoalCommandDelivery;
      try {
        delivery = await params.injectGoalCommand(buildClaudeGoalCommand({ type: 'clear' }));
      } catch {
        return stableError('session_goal_control_inject_failed');
      }
      if (!reachedAcceptedThreshold(delivery)) {
        return stableError('session_goal_control_inject_failed');
      }
      // The inject succeeded but Claude emits no `goal_status` for a clear (verified live), so remove
      // the work-state goal item directly — otherwise the badge keeps showing the now-stale goal.
      // Best-effort: a removal failure must not fail the clear itself.
      try {
        source.clearGoalWorkState();
      } catch {
        // Non-fatal: the `/goal clear` was injected; the metadata reconciliation is a follow-up.
      }
      return undefined;
    },
  };
}
