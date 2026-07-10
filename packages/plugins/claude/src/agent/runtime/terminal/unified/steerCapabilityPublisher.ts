import type { SessionAgentStateWriteRequestV1 } from '@happier-dev/plugin-sdk/sessions';

const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 1000;

export type ClaudeUnifiedSteerAvailabilitySnapshot = Readonly<{
  available: boolean;
  /** `user_terminal_draft` = X1 starvation escalation (a composer draft blocks steering). */
  reason: 'unsafe_window' | 'user_terminal_draft' | null;
}>;

export type ClaudeUnifiedSteerCapabilityPublisher = Readonly<{
  publish: (snapshot: ClaudeUnifiedSteerAvailabilitySnapshot) => void;
  dispose: () => void;
}>;

type PublishedSteerReason = 'unsafe_window' | 'user_terminal_draft' | 'turn_settling';

/**
 * Publishes the Claude Unified steer-availability snapshot (Seam A) into
 * `agentState.capabilities` so the UI's delivery decision can stop pretending a non-steerable
 * send was delivered. Fed by the turn-operations readiness/steer evaluation and:
 *
 * - maps unavailable → `turn_settling` when the canonical turn is no longer active — one
 *   turn-truth owner, no second turn-state source;
 * - de-duplicates identical states and rate-limits flapping screen vetoes with a trailing
 *   converging write (`minPublishIntervalMs`, default 1s);
 * - stamps `inFlightSteerStateAt` so the UI can ignore stale snapshots;
 * - degrades to a no-op on hosts without the `session.writeAgentState` seam (best-effort only);
 * - when `inFlightConfigApplySupported` is enabled (lane Q: the TUI runtime-control gate is ON),
 *   publishes that STATIC capability immediately at creation — the UI's "Apply & steer now" gate
 *   is fail-closed on this bit, so it must land before the first steer snapshot — and folds it
 *   into every later capability write so concurrent agent-state writers cannot clobber it.
 */
export function createClaudeUnifiedSteerCapabilityPublisher(opts: Readonly<{
  session: Readonly<{ writeAgentState?: (request: SessionAgentStateWriteRequestV1) => Promise<void> }>;
  logger: Readonly<{ debug: (message: string, meta?: Readonly<Record<string, unknown>>) => void }>;
  /** Canonical-turn probe; absent counts as active (fail-closed toward unsafe_window). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
  minPublishIntervalMs?: number | undefined;
  /**
   * Lane Q static capability: the runtime can own a steered message's config delta mid-turn.
   * Fail-closed — when false/absent the key is never written (the UI gate requires `=== true`).
   */
  inFlightConfigApplySupported?: boolean | undefined;
}>): ClaudeUnifiedSteerCapabilityPublisher {
  const sessionWriteAgentState = opts.session.writeAgentState;
  if (typeof sessionWriteAgentState !== 'function') {
    return { publish: () => undefined, dispose: () => undefined };
  }
  const writeAgentState: (request: SessionAgentStateWriteRequestV1) => Promise<void> = sessionWriteAgentState;
  const nowMs = opts.nowMs ?? Date.now;
  const minPublishIntervalMs = Math.max(0, opts.minPublishIntervalMs ?? DEFAULT_MIN_PUBLISH_INTERVAL_MS);
  const configApplySupported = opts.inFlightConfigApplySupported === true;

  function writeCapabilities(fields: Readonly<Record<string, unknown>>): void {
    const onWriteError = (error: unknown): void => {
      opts.logger.debug('[ClaudeUnifiedTerminal] steer capability publish failed (non-fatal)', { error });
    };
    try {
      void Promise.resolve(writeAgentState({
        kind: 'update',
        handler: (current) => ({
          ...current,
          capabilities: {
            ...(current.capabilities && typeof current.capabilities === 'object'
              ? current.capabilities as Readonly<Record<string, unknown>>
              : {}),
            terminalComposerClearSupported: true,
            ...(configApplySupported ? { inFlightConfigApplySupported: true } : {}),
            ...fields,
          },
        }),
      })).catch(onWriteError);
    } catch (error) {
      onWriteError(error);
    }
  }

  let disposed = false;
  let lastPublishedKey: string | null = null;
  let lastPublishAtMs: number | null = null;
  let pendingSnapshot: ClaudeUnifiedSteerAvailabilitySnapshot | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  function resolveReason(snapshot: ClaudeUnifiedSteerAvailabilitySnapshot): PublishedSteerReason | null {
    if (snapshot.available) return null;
    const canonicalActive = opts.isCanonicalTurnActive?.() ?? true;
    return canonicalActive ? (snapshot.reason ?? 'unsafe_window') : 'turn_settling';
  }

  function write(snapshot: ClaudeUnifiedSteerAvailabilitySnapshot): void {
    const reason = resolveReason(snapshot);
    const terminalComposerDraftPresent = snapshot.reason === 'user_terminal_draft';
    const key = `${snapshot.available}:${reason ?? ''}:${terminalComposerDraftPresent}`;
    if (key === lastPublishedKey) return;
    lastPublishedKey = key;
    lastPublishAtMs = nowMs();
    writeCapabilities({
      inFlightSteerAvailable: snapshot.available,
      inFlightSteerUnavailableReason: reason,
      inFlightSteerStateAt: lastPublishAtMs,
      terminalComposerDraftPresent,
    });
  }

  // Lane Q: land the static capability immediately (outside the snapshot dedup/rate-limit
  // bookkeeping) so the UI gate can open before the first steer-availability snapshot.
  if (configApplySupported) {
    writeCapabilities({});
  }

  function flushPending(): void {
    trailingTimer = null;
    if (disposed || pendingSnapshot === null) return;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    write(snapshot);
  }

  return {
    publish(snapshot) {
      if (disposed) return;
      const withinInterval = lastPublishAtMs !== null && nowMs() - lastPublishAtMs < minPublishIntervalMs;
      if (!withinInterval) {
        write(snapshot);
        return;
      }
      // Flap guard: coalesce rapid changes into one trailing write that converges on the latest.
      pendingSnapshot = snapshot;
      if (trailingTimer === null) {
        const delayMs = Math.max(0, minPublishIntervalMs - (nowMs() - (lastPublishAtMs ?? 0)));
        trailingTimer = setTimeout(flushPending, delayMs);
        trailingTimer.unref?.();
      }
    },
    dispose() {
      disposed = true;
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      pendingSnapshot = null;
    },
  };
}
