import type { DeploymentDomainContentV1, HealthCheckResultV1, HealthCheckSubjectV1 } from '@happier-dev/deployment-protocol/v1';
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
            healthCheck?: DeploymentDomainContentV1['healthCheck'] }>
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
    http: Pick<HttpService, 'request' | 'requestStream'>;
}>;

function endpoint(check: AdmittedHttpHealthCheckV1): Readonly<{ url: string; expectStatus: number }> | null {
    const target = check.target;
    let address: string;
    let expectStatus: number;
    if (target.kind === 'domain') {
        if (!target.healthCheck) return null;
        address = `https://${target.hostname}${target.healthCheck.path}`;
        expectStatus = target.healthCheck.expectStatus;
    } else {
        address = target.endpoint;
        expectStatus = target.expectStatus;
    }
    // Concatenation retains the admitted public authority even for a path
    // beginning with //; resolving that path as a URL would change its host.
    const url = new URL(address);
    // Fragments are never sent to the peer; compare the actual request URL.
    url.hash = '';
    return { url: url.href, expectStatus };
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
    const target = endpoint(check);
    if (!target) return result(check, kind, context, startedAt, 'unknown', {
        reason: 'not_checked', disclosure: 'No HTTP health probe is configured',
    });
    const { url, expectStatus } = target;
    let response: HttpResponse;
    let errorPrefix = '';
    try {
        const request = { url, method: 'GET' as const, redirect: 'manual' as const,
            headers: { 'User-Agent': 'Happier-Health-Check' } };
        if (kind === 'http' && check.keyword === undefined) {
            const stream = await context.http.requestStream(request, { signal: context.signal });
            try {
                // Healthy status-only probes still read no body. For Cloudflare's
                // plaintext refusal, inspect only the code plus its delimiter.
                if (stream.status === 403 && stream.headers.server?.toLowerCase() === 'cloudflare') {
                    const prefixLength = 'error code: 1010'.length + 1;
                    for await (const chunk of stream.chunks) {
                        errorPrefix += new TextDecoder().decode(chunk.subarray(0, prefixLength - errorPrefix.length));
                        if (errorPrefix.length >= prefixLength || !'error code: 1010'.startsWith(errorPrefix)) break;
                    }
                }
                response = { status: stream.status, finalUrl: stream.finalUrl,
                    headers: stream.headers, body: new Uint8Array() };
            } finally { await stream.dispose(); }
        } else {
            response = await context.http.request({ ...request,
                responseBody: kind === 'http' ? 'buffer' : 'discard',
                ...(kind === 'certificate' ? { observeTlsPeer: true as const } : {}),
            }, { signal: context.signal });
            if (kind === 'http') errorPrefix = new TextDecoder().decode(response.body.subarray(0, 'error code: 1010'.length + 1));
        }
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
        if (response.status === 403 && response.headers.server?.toLowerCase() === 'cloudflare'
            && /^error code: 1010(?:\s|$)/.test(errorPrefix)) {
            return result(check, kind, context, startedAt, 'down', { httpStatus: response.status, expectStatus,
                reason: 'cloudflare_browser_integrity', providerCode: 1010,
                disclosure: 'Cloudflare blocked the HTTP client signature; the application response was not observed',
                remedy: 'Review Cloudflare error 1010 guidance for this health client. Pages and workers.dev Browser Integrity Check cannot be disabled; other zones can adjust the blocking rule.' });
        }
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
