import type { HealthCheckKindV1, HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

export type HealthCheckObservationBasisV1 = Readonly<{
    observer: Readonly<{ machineId: string; installationId: string }>;
    vantage: 'sameMachine' | 'outside';
}>;

/** Finite producers retain facts only, never endpoints, answers, bodies or native error text. */
export function finiteHealthCheckResult(check: HealthCheckObservationBasisV1, kind: HealthCheckKindV1,
    observedAt: number, startedAt: number, status: HealthCheckResultV1['status'],
    facts: Omit<NonNullable<HealthCheckResultV1['cause']>, 'kind' | 'vantage' | 'observerMachineId'> = {}): HealthCheckResultV1 {
    return { status, observedAt, latencyMs: Math.max(0, observedAt - startedAt),
        cause: { kind, vantage: check.vantage, observerMachineId: check.observer.machineId,
            ...(check.vantage === 'sameMachine' ? { disclosure: 'checked from the server itself, not from outside' } : {}), ...facts },
        evidence: { v: 1, items: [{ source: { kind: 'alert', label: kind }, author: { kind: 'process' },
            text: `${kind} health check: ${status}${facts.reason ? ` (${facts.reason})` : ''}.` }] } };
}
