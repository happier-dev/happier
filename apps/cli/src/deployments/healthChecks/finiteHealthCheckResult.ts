import type { HealthCheckKindV1, HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

export type HealthCheckObservationBasisV1 = Readonly<{
    observer: Readonly<{ machineId: string; installationId: string }>;
    vantage: 'sameMachine' | 'outside';
}>;

/** Finite producers retain facts only, never endpoints, answers, bodies or native error text. */
export function finiteHealthCheckResult(check: HealthCheckObservationBasisV1, kind: HealthCheckKindV1,
    observedAt: number, startedAt: number, status: HealthCheckResultV1['status'],
    facts: Readonly<Record<string, string | number | boolean>>): HealthCheckResultV1 {
    return { status, observedAt, latencyMs: Math.max(0, observedAt - startedAt),
        evidence: { v: 1, items: [{ source: { kind: 'alert', label: kind }, author: { kind: 'process' },
            text: JSON.stringify({ kind, vantage: check.vantage, observerMachineId: check.observer.machineId,
                ...(check.vantage === 'sameMachine' ? { disclosure: 'checked from the server itself, not from outside' } : {}), ...facts }) }] } };
}
