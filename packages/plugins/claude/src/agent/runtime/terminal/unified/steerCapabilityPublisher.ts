import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

export type ClaudeUnifiedSteerAvailabilitySnapshot = Readonly<{
  available: boolean;
  /** `user_terminal_draft` = X1 starvation escalation (a composer draft blocks steering). */
  reason: 'unsafe_window' | 'user_terminal_draft' | null;
}>;

export type ClaudeUnifiedSteerCapabilityPublisher = Readonly<{
  publish: (snapshot: ClaudeUnifiedSteerAvailabilitySnapshot) => void;
  publishPendingInputInterruptAndRunLocalId: (localId: string | null) => void;
  readPendingInputInterruptAndRunStateAtMs: () => number | null;
  readStateUpdatedAtMs: () => number | null;
  dispose: () => void;
}>;

type PublishedSteerReason = 'unsafe_window' | 'user_terminal_draft' | 'turn_settling';

/**
 * Publishes the Claude Unified steer-availability snapshot through the host-owned active-input
 * status service so delivery decisions share the same runtime truth. Fed by the turn-operations
 * readiness/steer evaluation and:
 *
 * - maps unavailable → `turn_settling` when the canonical turn is no longer active — one
 *   turn-truth owner, no second turn-state source;
 * - publishes changed states immediately and de-duplicates identical observations;
 * - stamps `inFlightSteerStateAt` so the UI can ignore stale snapshots;
 * - when `inFlightConfigApplySupported` is enabled (lane Q: the TUI runtime-control gate is ON),
 *   publishes that STATIC capability immediately at creation — the UI's "Apply & steer now" gate
 *   is fail-closed on this bit, so it must land before the first steer snapshot — and folds it
 *   into every later capability write so concurrent agent-state writers cannot clobber it.
 */
export function createClaudeUnifiedSteerCapabilityPublisher(opts: Readonly<{
  publishStatus: AgentSessionRuntimeContext['session']['services']['activeInput']['publishStatus'];
  logger: Readonly<{ debug: (message: string, meta?: Readonly<Record<string, unknown>>) => void }>;
  /** Canonical-turn probe; absent counts as active (fail-closed toward unsafe_window). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
  /**
   * Lane Q static capability: the runtime can own a steered message's config delta mid-turn.
   * Fail-closed — when false/absent the key is never written (the UI gate requires `=== true`).
   */
  inFlightConfigApplySupported?: boolean | undefined;
}>): ClaudeUnifiedSteerCapabilityPublisher {
  const nowMs = opts.nowMs ?? Date.now;
  const configApplySupported = opts.inFlightConfigApplySupported === true;

  function publishStatus(status: Parameters<typeof opts.publishStatus>[0]): void {
    try {
      opts.publishStatus(status);
    } catch (error) {
      opts.logger.debug('[ClaudeUnifiedTerminal] steer capability publish failed (non-fatal)', { error });
    }
  }

  let disposed = false;
  let lastPublishedKey: string | null = null;
  let lastPublishAtMs: number | null = null;
  let pendingInputInterruptAndRunLocalId: string | null = null;
  let pendingInputInterruptAndRunStateAt: number | null = null;
  let lastAvailability: ClaudeUnifiedSteerAvailabilitySnapshot = {
    available: false,
    reason: 'unsafe_window',
  };

  function resolveReason(snapshot: ClaudeUnifiedSteerAvailabilitySnapshot): PublishedSteerReason | null {
    if (snapshot.available) return null;
    const canonicalActive = opts.isCanonicalTurnActive?.() ?? true;
    return canonicalActive ? (snapshot.reason ?? 'unsafe_window') : 'turn_settling';
  }

  function write(snapshot: ClaudeUnifiedSteerAvailabilitySnapshot): void {
    lastAvailability = snapshot;
    const reason = resolveReason(snapshot);
    const terminalComposerDraftPresent = snapshot.reason === 'user_terminal_draft';
    const key = `${snapshot.available}:${reason ?? ''}:${terminalComposerDraftPresent}`;
    if (key === lastPublishedKey) return;
    lastPublishedKey = key;
    lastPublishAtMs = nowMs();
    publishStatus({
      steerAvailable: snapshot.available,
      steerUnavailableReason: reason,
      stateUpdatedAtMs: lastPublishAtMs,
      terminalComposerDraftPresent,
      terminalComposerClearSupported: true,
      inFlightConfigurationApplySupported: configApplySupported,
      pendingInputInterruptAndRunLocalId,
      pendingInputInterruptAndRunStateAt,
    });
  }

  // Lane Q: land the static capability immediately (outside the snapshot dedup
  // bookkeeping) so the UI gate can open before the first steer-availability snapshot.
  if (configApplySupported) {
    publishStatus({
      steerAvailable: false,
      steerUnavailableReason: 'turn_settling',
      stateUpdatedAtMs: nowMs(),
      terminalComposerDraftPresent: false,
      terminalComposerClearSupported: true,
      inFlightConfigurationApplySupported: true,
      pendingInputInterruptAndRunLocalId,
      pendingInputInterruptAndRunStateAt,
    });
  }

  return {
    publish(snapshot) {
      if (disposed) return;
      write(snapshot);
    },
    publishPendingInputInterruptAndRunLocalId(localId) {
      if (disposed || pendingInputInterruptAndRunLocalId === localId) return;
      pendingInputInterruptAndRunLocalId = localId;
      pendingInputInterruptAndRunStateAt = nowMs();
      const reason = resolveReason(lastAvailability);
      publishStatus({
        steerAvailable: lastAvailability.available,
        steerUnavailableReason: reason,
        stateUpdatedAtMs: lastPublishAtMs ?? pendingInputInterruptAndRunStateAt,
        terminalComposerDraftPresent: lastAvailability.reason === 'user_terminal_draft',
        terminalComposerClearSupported: true,
        inFlightConfigurationApplySupported: configApplySupported,
        pendingInputInterruptAndRunLocalId,
        pendingInputInterruptAndRunStateAt,
      });
    },
    readPendingInputInterruptAndRunStateAtMs: () => pendingInputInterruptAndRunStateAt,
    readStateUpdatedAtMs: () => lastPublishAtMs,
    dispose() {
      if (pendingInputInterruptAndRunLocalId !== null) {
        pendingInputInterruptAndRunLocalId = null;
        pendingInputInterruptAndRunStateAt = nowMs();
        publishStatus({
          steerAvailable: lastAvailability.available,
          steerUnavailableReason: resolveReason(lastAvailability),
          stateUpdatedAtMs: lastPublishAtMs ?? pendingInputInterruptAndRunStateAt,
          terminalComposerDraftPresent: lastAvailability.reason === 'user_terminal_draft',
          terminalComposerClearSupported: true,
          inFlightConfigurationApplySupported: configApplySupported,
          pendingInputInterruptAndRunLocalId: null,
          pendingInputInterruptAndRunStateAt,
        });
      }
      disposed = true;
    },
  };
}
