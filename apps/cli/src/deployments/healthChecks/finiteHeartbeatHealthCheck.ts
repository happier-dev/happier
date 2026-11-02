import { finiteHealthCheckResult, type HealthCheckObservationBasisV1 } from './finiteHealthCheckResult';

/** Named heartbeat liveness: ingress owns accepted time; the existing observer
 * alone owns the strictly-after-period+grace deadline and D5 failure observations.
 * Null installs no deadline; settled late parks in that same loop until a hint.
 * This finite reader creates no timer, poll, receipt cache or background work. */
export function readHeartbeatHealthCheckV1(check: HealthCheckObservationBasisV1 & Readonly<{
    lastAcceptedAt: number | null; periodMs: number; graceMs: number;
}>, now: number) {
    const lateAt = check.lastAcceptedAt === null ? null : check.lastAcceptedAt + check.periodMs + check.graceMs + 1;
    const status = lateAt === null ? 'unknown' : now < lateAt ? 'up' : 'down';
    return { result: finiteHealthCheckResult(check, 'heartbeat', now, now, status,
        { reason: lateAt === null ? 'waiting_for_first_ping' : status === 'down' ? 'heartbeat_late' : 'heartbeat_current' }),
        nextEligibleAt: lateAt === null ? null : status === 'up' ? lateAt : now + check.periodMs };
}
