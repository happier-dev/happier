import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostLiveness } from '@/integrations/terminalHost/_types';
import { sanitizeTerminalHostDiagnosticText } from '@/integrations/terminalHost/sanitizeTerminalHostDiagnosticText';
import { delayUnrefAbortable } from '@/utils/time';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { readTerminalClientProcessState, terminalClientArgvMatchesInvocation } from '@/terminal/runtime/terminalClientCustody';
import type { OwnedTerminalProcessIdentity } from '@/terminal/runtime/ownedTerminalProcess';

import { ClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import type { ClaudeUnifiedStartableDisposable } from './_types';
import { emitClaudeUnifiedHostDead, type ClaudeUnifiedTelemetrySink } from './telemetry';

const DEFAULT_HOST_LIVENESS_POLL_MS = 30_000;
const DEFAULT_HOST_LIVENESS_CONFIRM_DEAD_POLL_MS = 1_000;
const DEFAULT_HOST_LIVENESS_MAX_JITTER_MS = 5_000;
// Match the established unified terminal sustained-starvation attention window. This escalates
// an unrecoverable probe outage without converting the absence of death evidence into death.
const DEFAULT_HOST_LIVENESS_PROBE_FAILURE_STARVATION_MS = 15_000;

function mergeDeadLivenessDiagnostics(
  pending: TerminalHostLiveness,
  latest: TerminalHostLiveness,
): TerminalHostLiveness {
  return { ...pending, ...latest };
}

function createProbeFailureLiveness(
  error: unknown,
  observedAt: number,
): TerminalHostLiveness {
  const message = error instanceof Error ? error.message : String(error);
  return {
    paneAlive: false,
    probeInconclusive: true,
    paneScreenDumpError: sanitizeTerminalHostDiagnosticText(message),
    observedAt,
  };
}

function stableJitterOffsetMs(handle: TerminalHostHandle, jitterWindowMs: number): number {
  if (jitterWindowMs <= 0) return 0;
  const key = `${handle.kind}:${handle.sessionName}:${handle.paneId ?? ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % (jitterWindowMs + 1);
}

export function createClaudeUnifiedHostLivenessBridge(opts: Readonly<{
  hostAdapter: Pick<TerminalHostAdapter, 'evaluateLiveness'>;
  handle: TerminalHostHandle;
  onHostDead: (error: ClaudeUnifiedTerminalHostDeadError) => void | Promise<void>;
  onProbeFailureStarvation?: ((params: Readonly<{
    liveness: TerminalHostLiveness;
    streakStartedAtMs: number;
    durationMs: number;
  }>) => void | Promise<void>) | undefined;
  onHostExited?: ((liveness: TerminalHostLiveness) => void | Promise<void>) | undefined;
  isExpectedHostExit?: ((liveness: TerminalHostLiveness) => boolean) | undefined;
  providerInvocation?: Readonly<{ command: string; args: readonly string[] }> | undefined;
  onProviderGone?: ((params: Readonly<{
    liveness: TerminalHostLiveness;
  }>) => void | Promise<void>) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  pollIntervalMs?: number | undefined;
  confirmDeadPollIntervalMs?: number | undefined;
  /** Retained for source compatibility; inconclusive probe failures are never death evidence. */
  probeFailureConfirmDeadMs?: number | undefined;
  /** Non-destructive attention threshold for an uninterrupted inconclusive probe episode. */
  probeFailureStarvationMs?: number | undefined;
  pollJitterMs?: number | undefined;
  startupGraceMs?: number | undefined;
  startupGraceActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
}>): ClaudeUnifiedStartableDisposable {
  const pollIntervalMs = Math.max(1, Math.trunc(opts.pollIntervalMs ?? DEFAULT_HOST_LIVENESS_POLL_MS));
  const confirmDeadPollIntervalMs = Math.max(
    1,
    Math.trunc(opts.confirmDeadPollIntervalMs ?? Math.min(DEFAULT_HOST_LIVENESS_CONFIRM_DEAD_POLL_MS, pollIntervalMs)),
  );
  const defaultJitterMs = pollIntervalMs >= 1_000
    ? Math.min(DEFAULT_HOST_LIVENESS_MAX_JITTER_MS, Math.floor(pollIntervalMs / 5))
    : 0;
  const pollJitterMs = Math.max(0, Math.trunc(opts.pollJitterMs ?? defaultJitterMs));
  const steadyStatePollDelayMs = pollIntervalMs + stableJitterOffsetMs(opts.handle, pollJitterMs);
  const startupGraceMs = Math.max(0, Math.trunc(opts.startupGraceMs ?? 0));
  const probeFailureStarvationMs = Math.max(
    1,
    Math.trunc(opts.probeFailureStarvationMs ?? DEFAULT_HOST_LIVENESS_PROBE_FAILURE_STARVATION_MS),
  );
  const nowMs = opts.nowMs ?? Date.now;
  let disposed = false;
  let started = false;
  let reported = false;
  let startedAtMs = 0;
  let pendingDeadLiveness: TerminalHostLiveness | null = null;
  let probeFailureStreakStartedAtMs: number | null = null;
  let probeFailureStarvationEscalated = false;
  let providerIdentity: OwnedTerminalProcessIdentity | null = null;
  let startupGracePreviouslyActive = opts.startupGraceActive?.() === true;

  const reportHostExited = async (liveness: TerminalHostLiveness): Promise<void> => {
    if (reported || disposed) return;
    reported = true;
    await opts.onHostExited?.(liveness);
  };

  const reportHostDead = async (liveness?: TerminalHostLiveness | undefined): Promise<void> => {
    if (reported || disposed) return;
    reported = true;
    if (opts.telemetry) {
      try {
        emitClaudeUnifiedHostDead(opts.telemetry, {
          hostKind: opts.handle.kind,
          sessionName: opts.handle.sessionName,
          paneId: opts.handle.paneId,
          liveness,
        });
      } catch {
        // Telemetry is diagnostic-only; host death must still reach the fatal path.
      }
    }
    await opts.onHostDead(new ClaudeUnifiedTerminalHostDeadError(liveness));
  };

  const reportProbeFailureStarvation = async (liveness: TerminalHostLiveness): Promise<void> => {
    const streakStartedAtMs = probeFailureStreakStartedAtMs;
    if (streakStartedAtMs === null || probeFailureStarvationEscalated || disposed) return;
    const durationMs = nowMs() - streakStartedAtMs;
    if (durationMs < probeFailureStarvationMs) return;
    probeFailureStarvationEscalated = true;
    try {
      await opts.onProbeFailureStarvation?.({ liveness, streakStartedAtMs, durationMs });
    } catch {
      // Attention delivery is diagnostic-only. An unsuccessful surface must not promote an
      // inconclusive probe to host death or interrupt the non-destructive liveness loop.
    }
  };

  const monitor = async (abortSignal: AbortSignal): Promise<void> => {
    while (!disposed && !abortSignal.aborted) {
      const startupGraceSignalActive = opts.startupGraceActive?.() === true;
      const startupGraceJustEnded = startupGracePreviouslyActive && !startupGraceSignalActive;
      await delayUnrefAbortable(
        pendingDeadLiveness !== null
          || probeFailureStreakStartedAtMs !== null
          || startupGraceSignalActive
          || startupGraceJustEnded
          ? confirmDeadPollIntervalMs
          : steadyStatePollDelayMs,
        abortSignal,
      );
      if (disposed || abortSignal.aborted) return;
      let liveness: TerminalHostLiveness;
      let probeFailed = false;
      try {
        liveness = await opts.hostAdapter.evaluateLiveness(opts.handle);
      } catch (error) {
        probeFailed = true;
        liveness = createProbeFailureLiveness(error, nowMs());
      }
      startupGracePreviouslyActive = opts.startupGraceActive?.() === true;
      if (disposed || abortSignal.aborted) return;
      const probeInconclusive = probeFailed || liveness.probeInconclusive === true;
      const providerInvocation = opts.providerInvocation;
      if (opts.onProviderGone && providerInvocation) {
        if (!providerIdentity && !probeInconclusive) {
          const candidates = liveness.paneForegroundProcesses?.filter(process =>
            terminalClientArgvMatchesInvocation(process.argv, providerInvocation));
          const candidate = candidates?.length === 1 ? candidates[0] : undefined;
          const fingerprint = candidate ? readProcessInstanceFingerprintSync(candidate.pid) : null;
          if (candidate && fingerprint) providerIdentity = { pid: candidate.pid, processInstanceFingerprint: fingerprint };
        }
        if (providerIdentity) {
          const state = await readTerminalClientProcessState(providerIdentity);
          if (disposed || abortSignal.aborted) return;
          if (state === 'dead') {
            // A foreground snapshot may omit a live provider. Only the identified OS
            // instance's exit proves termination; unknown identity/state never does.
            reported = true;
            await opts.onProviderGone({ liveness });
            return;
          }
        }
      }
      if (!liveness.paneAlive) {
        const graceActive = opts.startupGraceActive?.() ?? true;
        if (graceActive && startupGraceMs > 0 && nowMs() - startedAtMs < startupGraceMs) {
          pendingDeadLiveness = null;
          if (!probeInconclusive) {
            probeFailureStreakStartedAtMs = null;
          }
          continue;
        }
        if (probeInconclusive) {
          // Inconclusive: the probe itself failed (including ENOENT/EACCES when the bundled
          // zellij executable cannot be spawned), so it is never evidence of a dead host. It
          // cannot seed or confirm fatal death; bounded user-visible escalation belongs to the
          // existing recovery park policy, not this destructive liveness bridge.
          probeFailureStreakStartedAtMs ??= nowMs();
          await reportProbeFailureStarvation(liveness);
          continue;
        }
        probeFailureStreakStartedAtMs = null;
        if (opts.isExpectedHostExit?.(liveness) === true) {
          await reportHostExited(liveness);
          return;
        }
        if (pendingDeadLiveness === null) {
          pendingDeadLiveness = liveness;
          continue;
        }
        await reportHostDead(mergeDeadLivenessDiagnostics(pendingDeadLiveness, liveness));
        return;
      }
      pendingDeadLiveness = null;
      probeFailureStreakStartedAtMs = null;
      probeFailureStarvationEscalated = false;
    }
  };

  return {
    start({ abortSignal }) {
      if (disposed || started) return;
      started = true;
      startedAtMs = nowMs();
      return monitor(abortSignal);
    },
    dispose() {
      disposed = true;
    },
  };
}
