import type { HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentDomainDnsComparisonV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { readDnsAnswerHealthCheckV1 } from '@/deployments/healthChecks/finiteNetworkHealthCheck';
import { finiteHealthCheckResult, type HealthCheckObservationBasisV1 } from '@/deployments/healthChecks/finiteHealthCheckResult';

type Context = HealthCheckObservationBasisV1 & Readonly<{ signal: AbortSignal; startedAt: number }>;
export type NativeCaddyDnsChallenge = Readonly<{ id: string; path: string; token: string }>;

export function nativeCaddyDnsResult(context: Context, status: HealthCheckResultV1['status'],
    reason: string, facts: Readonly<Record<string, string | number | boolean>> = {}): HealthCheckResultV1 {
    return finiteHealthCheckResult(context, 'dns', Date.now(), context.startedAt, status, { reason, ...facts });
}

/** DNS resolution does not depend on an applied route or an installed listener. */
export async function readNativeCaddyDnsReadiness<T extends object>(hostname: string, context: Context,
    probe: () => Promise<T>, expectedIpv4: string | null | undefined):
    Promise<(HealthCheckResultV1 | T) & { dnsComparison?: DeploymentDomainDnsComparisonV1 }> {
    const [ipv4, ipv6] = await Promise.all([
        readDnsAnswerHealthCheckV1({ ...context, hostname, recordType: 'A' }, { signal: context.signal, now: Date.now }),
        readDnsAnswerHealthCheckV1({ ...context, hostname, recordType: 'AAAA' }, { signal: context.signal, now: Date.now }),
    ]);
    let resolution = ipv4.health;
    if (expectedIpv4) {
        if (ipv4.answers?.some(answer => answer !== expectedIpv4) || ipv4.answers?.length === 0 && ipv6.answers?.length) {
            resolution = nativeCaddyDnsResult(context, 'down', 'dns_mismatch', { recordType: 'A' });
        }
    } else if (ipv6.health.status === 'up' || ipv4.health.status === 'down' && ipv6.health.status === 'unknown') {
        if (ipv4.health.status !== 'up') resolution = ipv6.health;
    }
    const result = resolution.status === 'up' ? await probe() : resolution;
    return expectedIpv4 === undefined ? result : { ...result,
        dnsComparison: { expectedIpv4, answered: { A: ipv4.answers, AAAA: ipv6.answers } } };
}

/** This token proves routing, not TLS or application health. Never follow redirects
 * to another authority or retain a response body larger than the exact comparison. */
export async function readNativeCaddyDnsChallenge(hostname: string, challenge: NativeCaddyDnsChallenge,
    context: Context): Promise<HealthCheckResultV1> {
    context.signal.throwIfAborted();
    try {
        const response = await fetch(`http://${hostname}${challenge.path}`, {
            method: 'GET', redirect: 'manual', signal: context.signal,
            headers: { 'Cache-Control': 'no-cache' },
        });
        let matched = false;
        const reader = response.body?.getReader();
        if (reader) {
            try {
                if (response.status === 200) {
                    const expected = new TextEncoder().encode(challenge.token);
                    const actual = new Uint8Array(expected.length + 1);
                    let length = 0;
                    while (length < actual.length) {
                        const chunk = await reader.read();
                        context.signal.throwIfAborted();
                        if (chunk.done) break;
                        const take = Math.min(chunk.value.length, actual.length - length);
                        actual.set(chunk.value.subarray(0, take), length);
                        length += take;
                    }
                    matched = length === expected.length && expected.every((byte, index) => actual[index] === byte);
                }
            } finally {
                try { await reader.cancel(); } finally { reader.releaseLock(); }
            }
        }
        context.signal.throwIfAborted();
        return nativeCaddyDnsResult(context, matched ? 'up' : 'down', matched ? 'dns_ready' : 'dns_not_this_machine',
            { httpStatus: response.status });
    } catch (error) {
        context.signal.throwIfAborted();
        const native = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const { errorCode } = readUnexpectedActionErrorDiagnosticV1(native);
        return nativeCaddyDnsResult(context, 'unknown', 'dns_transport_unavailable', errorCode ? { errorCode } : {});
    }
}
