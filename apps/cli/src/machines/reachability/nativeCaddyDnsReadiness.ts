import type { HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDnsHealthCheckV1 } from '@/deployments/healthChecks/finiteNetworkHealthCheck';
import { finiteHealthCheckResult, type HealthCheckObservationBasisV1 } from '@/deployments/healthChecks/finiteHealthCheckResult';

type Context = HealthCheckObservationBasisV1 & Readonly<{ signal: AbortSignal; startedAt: number }>;
export type NativeCaddyDnsChallenge = Readonly<{ id: string; path: string; token: string }>;

export function nativeCaddyDnsResult(context: Context, status: HealthCheckResultV1['status'],
    reason: string, facts: Readonly<Record<string, string | number | boolean>> = {}): HealthCheckResultV1 {
    return finiteHealthCheckResult(context, 'dns', Date.now(), context.startedAt, status, { reason, ...facts });
}

/** Reuse the native DNS owner; either address family can serve the hostname. */
export async function readNativeCaddyDnsResolution(hostname: string, context: Context): Promise<HealthCheckResultV1> {
    const results = await Promise.all((['A', 'AAAA'] as const).map(recordType => readDnsHealthCheckV1(
        { ...context, hostname, recordType }, { signal: context.signal, now: Date.now })));
    return results.find(result => result.status === 'up')
        ?? results.find(result => result.status === 'unknown') ?? results[0]!;
}

/** DNS resolution does not depend on an applied route or an installed listener. */
export async function readNativeCaddyDnsReadiness<T>(hostname: string, context: Context,
    probe: () => Promise<T>): Promise<HealthCheckResultV1 | T> {
    const resolution = await readNativeCaddyDnsResolution(hostname, context);
    return resolution.status === 'up' ? probe() : resolution;
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
