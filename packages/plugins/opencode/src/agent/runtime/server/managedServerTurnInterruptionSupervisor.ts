import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';

import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export const OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE = 'opencode_server_restarted_during_turn';

export const MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW =
  "OpenCode's managed service became unavailable while a provider turn had in-flight tool work. "
  + 'The turn was marked failed instead of being left stuck.';

export type OpenCodeManagedServerTurnInterruptionAction =
  | 'continued_after_reconcile'
  | 'failed_turn_interrupted'
  | 'cleared_no_active_turn';

export type OpenCodeManagedServerTurnInterruptionDeps = Readonly<{
  logger: OpenCodeRuntimeContext['logger'];
  isTurnActive: () => boolean;
  readManagedServiceSnapshot: () => ManagedServiceSnapshot | null;
  reconcileLiveKnownToolStateFromHistory: () => Promise<void>;
  hasUnreconciledActiveLiveKnownToolWork: () => boolean;
  failActiveTurnDueToManagedServiceLoss: (input: Readonly<{ sanitizedPreview: string }>) => Promise<void>;
  resetProviderWorkForInterruptedTurn: () => void;
  clearOrphanedProviderWork: () => void;
  describeActiveProviderWorkForLog: () => Record<string, unknown>;
  getProviderSessionId: () => string | null;
}>;

export type OpenCodeManagedServerTurnInterruptionSupervisor = Readonly<{
  captureTurnStartSnapshot: () => void;
  observeManagedServiceSnapshot: () => Promise<void>;
}>;

function hasManagedServiceBeenLost(
  snapshot: ManagedServiceSnapshot | null,
): boolean {
  if (!snapshot) return true;
  return snapshot.state === 'stopping'
    || snapshot.state === 'stopped'
    || snapshot.state === 'failed';
}

function describeSnapshot(snapshot: ManagedServiceSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    state: snapshot.state,
    mode: snapshot.mode,
  };
}

export function createOpenCodeManagedServerTurnInterruptionSupervisor(
  deps: OpenCodeManagedServerTurnInterruptionDeps,
): OpenCodeManagedServerTurnInterruptionSupervisor {
  let turnStartSnapshot: ManagedServiceSnapshot | null = null;
  let lossHandled = false;
  let reconciliationInFlight: Promise<void> | null = null;

  const buildDiagnostics = (
    current: ManagedServiceSnapshot | null,
    action: OpenCodeManagedServerTurnInterruptionAction,
  ): Record<string, unknown> => ({
    action,
    turnStart: describeSnapshot(turnStartSnapshot),
    current: describeSnapshot(current),
    providerSessionId: deps.getProviderSessionId(),
    providerWork: deps.describeActiveProviderWorkForLog(),
  });

  const captureTurnStartSnapshot = (): void => {
    turnStartSnapshot = deps.readManagedServiceSnapshot();
    lossHandled = false;
    reconciliationInFlight = null;
  };

  const runReconciliationAndMaybeFail = async (
    current: ManagedServiceSnapshot | null,
  ): Promise<void> => {
    await deps.reconcileLiveKnownToolStateFromHistory().catch((error) => {
      deps.logger.debug('[OpenCodeServer] managed-service-loss reconciliation failed (non-fatal)', { error });
    });
    if (!deps.isTurnActive()) return;
    if (!deps.hasUnreconciledActiveLiveKnownToolWork()) {
      deps.logger.debug(
        '[OpenCodeServer] managed service was lost mid-turn; reconciled terminal work',
        buildDiagnostics(current, 'continued_after_reconcile'),
      );
      return;
    }
    deps.logger.debug(
      '[OpenCodeServer] managed service was lost with unreconciled tool work; failing turn',
      buildDiagnostics(current, 'failed_turn_interrupted'),
    );
    deps.resetProviderWorkForInterruptedTurn();
    await deps.failActiveTurnDueToManagedServiceLoss({
      sanitizedPreview: MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW,
    });
  };

  const observeManagedServiceSnapshot = (): Promise<void> => {
    const current = deps.readManagedServiceSnapshot();
    if (!turnStartSnapshot) {
      turnStartSnapshot = current;
      return Promise.resolve();
    }
    if (
      !lossHandled
      && !hasManagedServiceBeenLost(current)
    ) {
      return reconciliationInFlight ?? Promise.resolve();
    }
    if (lossHandled) return reconciliationInFlight ?? Promise.resolve();
    lossHandled = true;
    if (!deps.isTurnActive()) {
      deps.clearOrphanedProviderWork();
      deps.logger.debug(
        '[OpenCodeServer] managed service was lost with no active turn',
        buildDiagnostics(current, 'cleared_no_active_turn'),
      );
      return Promise.resolve();
    }
    const pending = runReconciliationAndMaybeFail(current)
      .catch((error) => {
        deps.logger.debug('[OpenCodeServer] managed-service-loss supervision failed (non-fatal)', { error });
      })
      .finally(() => {
        reconciliationInFlight = null;
      });
    reconciliationInFlight = pending;
    return pending;
  };

  return {
    captureTurnStartSnapshot,
    observeManagedServiceSnapshot,
  };
}
