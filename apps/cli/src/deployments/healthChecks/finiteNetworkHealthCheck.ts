import { Resolver } from 'node:dns/promises';
import { createConnection } from 'node:net';
import type { HealthCheckResultV1, HealthCheckTcpConfigV1, HealthCheckDnsConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { finiteHealthCheckResult, type HealthCheckObservationBasisV1 } from './finiteHealthCheckResult';

type Context = Readonly<{ signal: AbortSignal; now(): number }>;

function nativeCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Exactly one native connection, released on connect, failure or caller cancellation.
 * The OS and containing finite invocation own its lifetime; no probe-local timeout. */
export async function readTcpHealthCheckV1(check: HealthCheckObservationBasisV1 & HealthCheckTcpConfigV1,
    context: Context): Promise<HealthCheckResultV1> {
    context.signal.throwIfAborted();
    const startedAt = context.now();
    let status: HealthCheckResultV1['status'] = 'up';
    let reason = 'connected';
    try {
        await new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: check.host, port: check.port, signal: context.signal });
            socket.once('connect', () => { socket.destroy(); resolve(); });
            socket.once('error', error => { socket.destroy(); reject(error); });
        });
    } catch (error) {
        context.signal.throwIfAborted();
        const code = nativeCode(error);
        status = code !== undefined && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) ? 'down' : 'unknown';
        reason = status === 'down' ? 'connection_failed' : 'connection_unavailable';
    }
    context.signal.throwIfAborted();
    return finiteHealthCheckResult(check, 'tcp', context.now(), startedAt, status, { reason });
}

function answerStrings(value: unknown): readonly string[] {
    if (typeof value === 'string') return [value];
    // TXT chunks comprise one record, rather than independently matching chunks.
    if (Array.isArray(value)) return value.every(item => typeof item === 'string') ? [value.join('')] : [];
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    return ['address', 'exchange', 'name', 'nsname', 'replacement', 'issue', 'issuewild', 'iodef']
        .flatMap(key => typeof record[key] === 'string' ? [record[key]] : []);
}

/** One native resolver request. Cancellation tears down this request's resolver,
 * never another source's DNS query. Missing/mismatch differs from unavailable DNS. */
export async function readDnsHealthCheckV1(check: HealthCheckObservationBasisV1 & HealthCheckDnsConfigV1,
    context: Context): Promise<HealthCheckResultV1> {
    context.signal.throwIfAborted();
    const startedAt = context.now();
    const resolver = new Resolver();
    const cancel = () => resolver.cancel();
    context.signal.addEventListener('abort', cancel, { once: true });
    let status: HealthCheckResultV1['status'];
    let reason: string;
    try {
        const resolved: unknown = await resolver.resolve(check.hostname, check.recordType);
        context.signal.throwIfAborted();
        const answers = (Array.isArray(resolved) ? resolved : [resolved]).flatMap(answerStrings);
        const matched = check.expectedAnswer === undefined || answers.includes(check.expectedAnswer);
        status = answers.length > 0 && matched ? 'up' : 'down';
        reason = answers.length === 0 ? 'dns_missing' : matched ? 'dns_matched' : 'dns_mismatch';
    } catch (error) {
        context.signal.throwIfAborted();
        const code = nativeCode(error);
        status = code === 'ENODATA' || code === 'ENOTFOUND' ? 'down' : 'unknown';
        reason = status === 'down' ? 'dns_missing' : 'resolver_unavailable';
    } finally {
        context.signal.removeEventListener('abort', cancel);
    }
    return finiteHealthCheckResult(check, 'dns', context.now(), startedAt, status, { reason, recordType: check.recordType });
}
