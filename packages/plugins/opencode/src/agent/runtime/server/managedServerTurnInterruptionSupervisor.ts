import {
  describeOpenCodeManagedServerGenerationForLog,
  isSameOpenCodeManagedServerGeneration,
  type OpenCodeManagedServerGenerationIdentity,
} from './managedServerGeneration.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

/**
 * Foreground-runtime `SessionRuntimeIssueV1` code emitted when the managed `opencode serve` process is
 * replaced mid-turn and the in-flight tool work cannot be reconciled from durable history.
 *
 * `SessionRuntimeIssueV1.code` is an open string (`z.string().min(1)`), not a closed protocol union,
 * so this constant is the single source of truth for the plugin runtime and any aligned e2e fixture.
 * Keep the literal in sync with remote-dev's
 * `apps/cli/src/backends/opencode/server/runtime/createOpenCodeManagedServerTurnInterruptionSupervisor.ts`
 * and `packages/tests/src/testkit/fakeOpenCodeServer.ts`.
 */
export const OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE = 'opencode_server_restarted_during_turn';

export const MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW =
  "OpenCode's managed server restarted while a provider turn had in-flight tool work. "
  + 'The turn was marked failed instead of being left stuck.';

export type OpenCodeManagedServerTurnInterruptionAction =
  | 'continued_after_reconcile'
  | 'failed_turn_interrupted'
  | 'cleared_no_active_turn'
  | 'ignored_no_generation_change';

export type OpenCodeManagedServerTurnInterruptionDeps = Readonly<{
  logger: OpenCodeRuntimeContext['logger'];
  /** True while a Happier turn is active (turn in flight). */
  isTurnActive: () => boolean;
  /**
   * Current managed-server identity derived from the host snapshot (null in external-attach mode or
   * when no snapshot is available). `../dev` has no in-place restart and no client-side identity
   * change event; the runtime polls the snapshot, so the supervisor observes the identity directly.
   */
  readOpenCodeManagedServerGenerationIdentity: () => OpenCodeManagedServerGenerationIdentity | null;
  /** Forward the active observation generation to the provider activity tracker. */
  setObservedGenerationKey: (generationKey: string | null) => void;
  /** Run ONE bounded reconciliation of live-known ids from the replacement server's durable history. */
  reconcileLiveKnownToolStateFromHistory: () => Promise<void>;
  /** True if any live-known tool call of the active turn is still active (non-terminal) after reconcile. */
  hasUnreconciledActiveLiveKnownToolWork: (currentGenerationKey: string | null) => boolean;
  /** Fail the active turn exactly once with the server-restart issue (no abort/replay/completion). */
  failActiveTurnDueToManagedServerRestart: (input: Readonly<{ sanitizedPreview: string }>) => Promise<void>;
  /** Reset all provider activity for the interrupted turn. */
  resetProviderWorkForInterruptedTurn: () => void;
  /** Drop provider work not backed by the given (current) generation. */
  clearOrphanedProviderWork: (currentGenerationKey: string | null) => void;
  /** Sanitized snapshot of active provider work for diagnostics (no tool inputs/outputs). */
  describeActiveProviderWorkForLog: () => Record<string, unknown>;
  getProviderSessionId: () => string | null;
}>;

export type OpenCodeManagedServerTurnInterruptionSupervisor = Readonly<{
  /** Capture the managed-server generation at the moment a turn starts. */
  captureTurnStartGeneration: () => void;
  /**
   * Observe the current managed-server identity (called on each completion poll / status event). If
   * the generation changed mid-turn, runs the reconcile-once-then-fail policy and resolves when it
   * settles; otherwise resolves immediately (or surfaces an in-flight reconciliation). Idempotent.
   */
  observeManagedServerGeneration: () => Promise<void>;
  /** Generation the runtime currently believes it is talking to (for generation-aware liveness). */
  getCurrentGenerationKey: () => string | null;
}>;

export function createOpenCodeManagedServerTurnInterruptionSupervisor(
  deps: OpenCodeManagedServerTurnInterruptionDeps,
): OpenCodeManagedServerTurnInterruptionSupervisor {
  let turnStartGenerationKey: string | null = null;
  let currentGenerationKey: string | null = null;
  let currentIdentity: OpenCodeManagedServerGenerationIdentity | null = null;
  // Bounded reconciliation is single-flight per detected change; the underlying failTurn is itself
  // guarded to run exactly once, so coalescing concurrent change observations is safe.
  let reconciliationInFlight: Promise<void> | null = null;

  const getCurrentGenerationKey = (): string | null =>
    currentGenerationKey ?? deps.readOpenCodeManagedServerGenerationIdentity()?.generationKey ?? null;

  const captureTurnStartGeneration = (): void => {
    const identity = deps.readOpenCodeManagedServerGenerationIdentity();
    currentIdentity = identity;
    turnStartGenerationKey = identity?.generationKey ?? null;
    currentGenerationKey = turnStartGenerationKey;
    deps.setObservedGenerationKey(currentGenerationKey);
  };

  const buildDiagnostics = (
    previous: OpenCodeManagedServerGenerationIdentity | null,
    next: OpenCodeManagedServerGenerationIdentity | null,
    action: OpenCodeManagedServerTurnInterruptionAction,
  ): Record<string, unknown> => ({
    action,
    turnStartGenerationKey: turnStartGenerationKey ? turnStartGenerationKey.slice(0, 12) : null,
    currentGenerationKey: currentGenerationKey ? currentGenerationKey.slice(0, 12) : null,
    previous: describeOpenCodeManagedServerGenerationForLog(previous),
    current: describeOpenCodeManagedServerGenerationForLog(next),
    providerSessionId: deps.getProviderSessionId(),
    providerWork: deps.describeActiveProviderWorkForLog(),
  });

  const runReconciliationAndMaybeFail = async (
    previous: OpenCodeManagedServerGenerationIdentity | null,
    next: OpenCodeManagedServerGenerationIdentity | null,
  ): Promise<void> => {
    // ONE bounded reconciliation of live-known ids from the replacement server's durable history.
    await deps.reconcileLiveKnownToolStateFromHistory().catch((error) => {
      deps.logger.debug('[OpenCodeServer] managed-server-restart reconciliation failed (non-fatal)', { error });
    });

    if (!deps.isTurnActive()) {
      // The turn settled (resolved/failed) while reconciling; nothing further to do.
      return;
    }

    if (!deps.hasUnreconciledActiveLiveKnownToolWork(currentGenerationKey)) {
      // Reconciled terminal, or no live-known tool work existed: let the existing completion gate /
      // idle fallback own the rest.
      deps.logger.debug(
        '[OpenCodeServer] managed server generation changed mid-turn; reconciled, turn continues',
        buildDiagnostics(previous, next, 'continued_after_reconcile'),
      );
      return;
    }

    deps.logger.debug(
      '[OpenCodeServer] managed server restarted mid-turn with unreconciled tool work; failing turn',
      buildDiagnostics(previous, next, 'failed_turn_interrupted'),
    );
    // Reset provider activity for the dead turn before failing so liveness settles cleanly.
    deps.resetProviderWorkForInterruptedTurn();
    await deps.failActiveTurnDueToManagedServerRestart({
      sanitizedPreview: MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW,
    });
  };

  /**
   * Observe the current managed-server identity. Returns the (single-flight) reconciliation promise
   * when a mid-turn replacement triggers reconcile-then-fail, or a resolved promise otherwise. The
   * synchronous-completion / event paths can `await` it for deterministic failure; fire-and-forget
   * callers can ignore it.
   */
  const observeManagedServerGeneration = (): Promise<void> => {
    const next = deps.readOpenCodeManagedServerGenerationIdentity();
    const previous = currentIdentity;
    if (isSameOpenCodeManagedServerGeneration(previous, next)) {
      // No replacement: keep the believed generation in sync (covers the initial-null → present case
      // where the key is the same value once present) and return cheaply. If a reconciliation is
      // already in flight, surface it so callers can await deterministically.
      currentIdentity = next;
      return reconciliationInFlight ?? Promise.resolve();
    }

    currentIdentity = next;
    const nextGenerationKey = next?.generationKey ?? null;
    currentGenerationKey = nextGenerationKey;
    deps.setObservedGenerationKey(nextGenerationKey);

    if (!deps.isTurnActive()) {
      // No user-visible failure when idle; just drop orphaned work bound to the dead generation.
      deps.clearOrphanedProviderWork(nextGenerationKey);
      deps.logger.debug(
        '[OpenCodeServer] managed server generation changed with no active turn',
        buildDiagnostics(previous, next, 'cleared_no_active_turn'),
      );
      return Promise.resolve();
    }

    if (turnStartGenerationKey === null) {
      // No baseline was established at turn start (identity was unknown). Adopt the observed
      // generation so we never fail on a first-ever observation; the generation-aware completion gate
      // remains the safety net if work is genuinely orphaned.
      turnStartGenerationKey = nextGenerationKey;
      return Promise.resolve();
    }

    if (nextGenerationKey !== null && nextGenerationKey === turnStartGenerationKey) {
      // Same generation as turn start: not a real replacement.
      return Promise.resolve();
    }

    if (reconciliationInFlight) return reconciliationInFlight;
    const pending = runReconciliationAndMaybeFail(previous, next)
      .catch((error) => {
        deps.logger.debug('[OpenCodeServer] managed-server-restart supervision failed (non-fatal)', { error });
      })
      .finally(() => {
        reconciliationInFlight = null;
      });
    reconciliationInFlight = pending;
    return pending;
  };

  return {
    captureTurnStartGeneration,
    observeManagedServerGeneration,
    getCurrentGenerationKey,
  };
}
