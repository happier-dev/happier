import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import type { AutomationLeaseRenewalProgress } from './automationClaimClient';

export type AutomationLeaseObservation = Readonly<{
  event: 'renewal_started' | 'renewed' | 'transient_failure' | 'refused' | 'expired' | 'stopped' | 'late_response';
  observedAtMs: number;
  scheduledAtMs: number;
  leaseExpiresAtMs: number;
  renewalStartedAtMs: number | null;
  renewalScheduledAtMs: number | null;
  renewalTransport: AutomationLeaseRenewalProgress | null;
  renewalInFlight: boolean;
}>;

export function startAutomationLeaseHeartbeat(params: {
  heartbeatMs: number;
  leaseExpiresAtMs: number;
  onHeartbeat: (onProgress: (progress: AutomationLeaseRenewalProgress) => void, renewalDeadlineAtMs: number, signal: AbortSignal) => Promise<number>;
  onError: (error: unknown) => void;
  onTransientError?: (error: unknown) => void;
  onObservation?: (observation: AutomationLeaseObservation) => void;
}): { stop: () => void } {
  let active = true;
  let leaseExpiresAtMs = params.leaseExpiresAtMs;
  let cancelTimer: (() => void) | undefined;
  let inFlight = false;
  let scheduledAtMs = Date.now();
  let renewalStartedAtMs: number | null = null;
  let renewalScheduledAtMs: number | null = null;
  let renewalTransport: AutomationLeaseRenewalProgress | null = null;
  let renewalController: AbortController | null = null;
  const cadenceMs = params.heartbeatMs;
  const nextHealthyRenewalAtMs = () => {
    const now = Date.now();
    const remainingMs = leaseExpiresAtMs - now;
    // Delivery and proof/HTTP latency consume the granted lease. A nearly
    // spent claim renews immediately; healthy fresh leases keep their cadence.
    return now + (remainingMs <= cadenceMs ? 0 : Math.min(cadenceMs, Math.ceil(remainingMs / 2)));
  };
  let nextRenewalAtMs = nextHealthyRenewalAtMs();
  const observe = (event: AutomationLeaseObservation['event']) => {
    try {
      params.onObservation?.({ event, observedAtMs: Date.now(), scheduledAtMs, leaseExpiresAtMs,
        renewalStartedAtMs, renewalScheduledAtMs, renewalTransport, renewalInFlight: inFlight });
    } catch { /* Local diagnostics cannot change claim ownership. */ }
  };
  const stop = () => {
    if (!active) return;
    observe('stopped');
    active = false;
    cancelTimer?.();
    renewalController?.abort();
  };
  const fail = (error: unknown, event: 'expired' | 'refused' = 'refused') => {
    if (!active) return;
    observe(event);
    active = false;
    cancelTimer?.();
    renewalController?.abort(error);
    params.onError(error);
  };
  const expire = () => fail(Object.assign(new Error('automation_claim_lease_expired'), { code: 'automation_claim_lease_expired' }), 'expired');
  const schedule = () => {
    if (!active) return;
    const remainingMs = leaseExpiresAtMs - Date.now();
    if (remainingMs <= 0) { expire(); return; }
    // A pending renewal and its transport share the confirmed lease expiry.
    const nextBoundaryAtMs = inFlight ? leaseExpiresAtMs : nextRenewalAtMs;
    const delayMs = Math.min(Math.max(0, nextBoundaryAtMs - Date.now()), remainingMs);
    scheduledAtMs = Date.now() + delayMs;
    cancelTimer = armDeadlineTimer(scheduledAtMs, tick);
  };
  const tick = () => {
    if (!active) return;
    if (Date.now() >= leaseExpiresAtMs) { expire(); return; }
    if (inFlight) {
      schedule();
      return;
    }
    inFlight = true;
    renewalScheduledAtMs = scheduledAtMs;
    const startedAtMs = Date.now();
    renewalStartedAtMs = startedAtMs;
    renewalTransport = null;
    renewalController = new AbortController();
    // Proof preparation and HTTP share the confirmed lease's actual deadline.
    observe('renewal_started');
    schedule();
    void params.onHeartbeat(progress => { renewalTransport = progress; }, leaseExpiresAtMs, renewalController.signal).then(expiresAtMs => {
      if (!active) { observe('late_response'); return; }
      if (Date.now() >= leaseExpiresAtMs || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        expire();
        return;
      }
      leaseExpiresAtMs = expiresAtMs;
      observe('renewed');
      nextRenewalAtMs = nextHealthyRenewalAtMs();
    }).catch((error: unknown) => {
      if (!active) { observe('late_response'); return; }
      const { kind } = classifyDaemonServerWorkError(error);
      if (kind === 'network' || kind === 'timeout' || kind === 'server_error'
        || kind === 'dependency_unavailable' || kind === 'rate_limited') {
        observe('transient_failure');
        params.onTransientError?.(error);
        nextRenewalAtMs = Date.now() + Math.min(cadenceMs, Math.ceil((leaseExpiresAtMs - Date.now()) / 2));
      } else {
        fail(error);
      }
    }).finally(() => {
      inFlight = false;
      renewalController = null;
      cancelTimer?.();
      schedule();
    });
  };
  schedule();
  return { stop };
}
