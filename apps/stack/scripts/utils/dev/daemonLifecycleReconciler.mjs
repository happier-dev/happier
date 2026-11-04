import { performance } from 'node:perf_hooks';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readStackRuntimeDaemonDesiredState } from '../stack/runtime_daemon_state.mjs';

export function startOwnerDaemonLifecycleReconciler(
  {
    enabled,
    runtimeStatePath = null,
    cliIdentity = 'default',
    observe,
    onObservation,
    onObservationIntervalMs = 0,
    recover,
    isRecoveryEnabled = () => true,
    isRecoveryReady = async () => true,
    isShuttingDown = () => false,
    intervalMs = 1_000,
    absenceConfirmations = 2,
  } = {},
  {
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    nowImpl = () => performance.now(),
    logger = console,
  } = {},
) {
  if (!enabled || typeof observe !== 'function') return null;

  let closed = false;
  let inFlight = null;
  let consecutiveAbsences = 0;
  let recoveryAttempted = false;
  let lastObservationDeliveryAt = null;
  const requiredAbsences = Math.max(2, Number(absenceConfirmations) || 2);

  const runReconciliation = async () => {
    const observedAt = nowImpl();
    const deliverObservation = typeof onObservation === 'function' && (
      lastObservationDeliveryAt === null
      || observedAt - lastObservationDeliveryAt >= onObservationIntervalMs
    );
    const stoppedByOwner = runtimeStatePath && readStackRuntimeDaemonDesiredState(
      await readStackRuntimeStateFile(runtimeStatePath), { cliIdentity },
    ) === 'stopped';
    const recoveryEnabled = !stoppedByOwner && typeof recover === 'function' && isRecoveryEnabled() === true;
    // Auth-gated recovery previously did no probe between membership samples.
    // Retain that behavior under the shared observation owner.
    if (!recoveryEnabled && typeof onObservation === 'function' && !deliverObservation) {
      consecutiveAbsences = 0;
      recoveryAttempted = false;
      return { skipped: true, reason: stoppedByOwner ? 'daemon-stopped-by-owner' : 'daemon-recovery-not-ready' };
    }
    const observation = await observe();
    if (deliverObservation) {
      // Membership persistence retains its existing cadence while consuming
      // the lifecycle owner's observation instead of opening another probe.
      lastObservationDeliveryAt = observedAt;
      try {
        await onObservation(observation);
      } catch (error) {
        logger?.warn?.(
          `[stack] daemon runtime pid reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (typeof recover !== 'function') return { skipped: true, reason: 'observation-only' };
    if (!recoveryEnabled) {
      consecutiveAbsences = 0;
      recoveryAttempted = false;
      return { skipped: true, reason: stoppedByOwner ? 'daemon-stopped-by-owner' : 'daemon-recovery-not-ready' };
    }
    const status = String(observation?.status ?? '').trim();
    if (status === 'running' || status === 'starting' || status === 'unreachable') {
      consecutiveAbsences = 0;
      recoveryAttempted = false;
      return { skipped: true, reason: 'daemon-present', status };
    }

    if (!['stopped', 'stale_state', 'stale_lock'].includes(status)) {
      consecutiveAbsences = 0;
      recoveryAttempted = false;
      return { skipped: true, reason: 'daemon-state-inconclusive', status: status || 'unknown' };
    }

    if (await isRecoveryReady({ observation }) !== true) {
      consecutiveAbsences = 0;
      recoveryAttempted = false;
      return { skipped: true, reason: 'daemon-recovery-not-ready' };
    }

    consecutiveAbsences = Math.min(requiredAbsences, consecutiveAbsences + 1);
    if (consecutiveAbsences < requiredAbsences) {
      return { skipped: true, reason: 'daemon-absence-unconfirmed', consecutiveAbsences };
    }

    if (recoveryAttempted) {
      return { skipped: true, reason: 'daemon-recovery-already-attempted' };
    }
    recoveryAttempted = true;
    return await recover({ observation, consecutiveAbsences });
  };

  const reconcileNow = async () => {
    if (closed || isShuttingDown?.() === true) return { skipped: true, reason: 'closed' };
    if (inFlight) return await inFlight;
    inFlight = Promise.resolve()
      .then(() => runReconciliation())
      .catch((error) => {
        consecutiveAbsences = 0;
        logger?.warn?.(
          `[local] daemon lifecycle reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { skipped: true, reason: 'reconcile-failed', error };
      })
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  };

  const timer = setIntervalImpl(() => {
    void reconcileNow();
  }, Math.max(250, Number(intervalMs) || 1_000));
  timer?.unref?.();

  return {
    reconcileNow,
    close() {
      closed = true;
      clearIntervalImpl(timer);
    },
  };
}
