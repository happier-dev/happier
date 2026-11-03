import type { HealthCheckResultV1, HealthCheckSubjectV1 } from '@happier-dev/deployment-protocol/v1';
import type { HttpService, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { isNativeTlsErrorCode } from '@/plugins/runtime/fetch/tlsError';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';

/** P50 resolves these facts from the current saved source and chosen observer.
 * This host-internal value is never an Action operand or network authority. */
export type AdmittedHttpHealthCheckV1 = Readonly<{
    sourceInstanceId: string;
    checkId: string;
    subject: HealthCheckSubjectV1;
    observer: Readonly<{ machineId: string; installationId: string }>;
    vantage: 'sameMachine' | 'outside';
    target:
        | Readonly<{ kind: 'domain'; environmentId: string; targetLinkId: string; domainId: string;
            domainRevision: number; targetLinkRevision: number; hostname: string;
            healthCheck: Readonly<{ path: string; expectStatus: number }> }>
        | Readonly<{ kind: 'machineService'; machineId: string; serviceId: string;
            endpoint: string; expectStatus: number }>;
    keyword?: string;
}>;

export type HealthCheckFiniteLeafContextV1 = Readonly<{
    signal: AbortSignal;
    now(): number;
    isCurrent(): Promise<boolean>;
    /** The existing HTTP owner bound by P50 to this exact saved endpoint,
     * observer and network policy, including destination/redirect admission. */
    http: Pick<HttpService, 'request'>;
}>;

function endpoint(check: AdmittedHttpHealthCheckV1): string {
    // Concatenation retains the admitted public authority even for a path
    // beginning with //; resolving that path as a URL would change its host.
    const url = new URL(check.target.kind === 'machineService' ? check.target.endpoint
        : `https://${check.target.hostname}${check.target.healthCheck.path}`);
    // Fragments are never sent to the peer; compare the actual request URL.
    url.hash = '';
    return url.href;
}

function nativeFailure(error: unknown, url: string): 'tls' | 'connection' | undefined {
    if (!(error instanceof Error)) return;
    const native = error.cause instanceof Error ? error.cause : error;
    if (!('code' in native) || typeof native.code !== 'string') return;
    if (isNativeTlsErrorCode(native.code, new URL(url).protocol === 'https:')) return 'tls';
    // Reset/timeout may occur after headers while reading a keyword body;
    // those are incomplete evidence, not a proved connection refusal.
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(native.code)) {
        return 'connection';
    }
    return undefined;
}

async function assertCurrent(context: HealthCheckFiniteLeafContextV1): Promise<void> {
    context.signal.throwIfAborted();
    if (!await context.isCurrent()) throw new PluginError({ code: 'admission_unavailable',
        message: 'The saved health check or its observer is no longer current' });
    context.signal.throwIfAborted();
}

function result(check: AdmittedHttpHealthCheckV1, kind: 'http' | 'certificate',
    context: HealthCheckFiniteLeafContextV1, startedAt: number, status: HealthCheckResultV1['status'],
    facts: Readonly<Record<string, string | number | boolean>>): HealthCheckResultV1 {
    const observedAt = context.now();
    return finiteHealthCheckResult(check, kind, observedAt, startedAt, status, facts);
}

async function observe(check: AdmittedHttpHealthCheckV1, context: HealthCheckFiniteLeafContextV1,
    kind: 'http' | 'certificate'): Promise<HealthCheckResultV1> {
    await assertCurrent(context);
    const startedAt = context.now();
    const url = endpoint(check);
    let response: HttpResponse;
    try {
        response = await context.http.request({ url, method: 'GET', redirect: 'manual',
            responseBody: kind === 'http' && check.keyword !== undefined ? 'buffer' : 'discard',
            ...(kind === 'certificate' ? { observeTlsPeer: true as const } : {}),
        }, { signal: context.signal });
    } catch (error) {
        await assertCurrent(context);
        // Authority/policy failures retain the transport's typed reason. A body
        // exceeding its existing budget is incomplete keyword evidence.
        if (isPluginError(error) && error.code !== 'plugin_fetch_response_too_large') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const failure = nativeFailure(error, url);
        if (failure === 'tls' || (failure === 'connection' && kind === 'http')) {
            return result(check, kind, context, startedAt, 'down', { reason: failure });
        }
        return result(check, kind, context, startedAt, 'unknown', { reason: 'transport_incomplete' });
    }
    await assertCurrent(context);
    if (kind === 'http') {
        const expectStatus = check.target.kind === 'domain' ? check.target.healthCheck.expectStatus : check.target.expectStatus;
        const statusMatched = response.status === expectStatus;
        const keywordMatched = check.keyword === undefined || new TextDecoder().decode(response.body).includes(check.keyword);
        return result(check, kind, context, startedAt, statusMatched && keywordMatched ? 'up' : 'down',
            { httpStatus: response.status, expectStatus, ...(check.keyword === undefined ? {} : { keywordMatched }) });
    }
    const peer = response.tlsPeer;
    if (!peer || peer.url !== url || response.finalUrl !== url) {
        return result(check, kind, context, startedAt, 'unknown', { reason: 'certificate_unobserved' });
    }
    const now = context.now();
    return result(check, kind, context, startedAt, peer.notBefore <= now && now < peer.notAfter ? 'up' : 'down',
        { fingerprint256: peer.fingerprint256, notBefore: peer.notBefore, notAfter: peer.notAfter });
}

/** One finite observation; P50 alone owns scheduling, transitions and C1. */
export function readHttpHealthCheckV1(check: AdmittedHttpHealthCheckV1,
    context: HealthCheckFiniteLeafContextV1): Promise<HealthCheckResultV1> {
    return observe(check, context, 'http');
}

/** Native peer from this exact request, independently of HTTP status/body. */
export function readCertificateHealthCheckV1(check: AdmittedHttpHealthCheckV1,
    context: HealthCheckFiniteLeafContextV1): Promise<HealthCheckResultV1> {
    return observe(check, context, 'certificate');
}
