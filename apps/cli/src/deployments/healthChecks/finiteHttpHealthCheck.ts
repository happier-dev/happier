import type { DeploymentDomainContentV1, HealthCheckResultV1, HealthCheckSubjectV1 } from '@happier-dev/deployment-protocol/v1';
import type { HttpService, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
import { isNativeTlsErrorCode } from '@/plugins/runtime/fetch/tlsError';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';
import { readHealthCheckHttpTargetV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { deploymentDomainHealthStatusMatchesV1 } from '@happier-dev/protocol/deployments/deploymentDomainHealthCheckV1';

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
            endpoint: string; expectStatus: number }>
        | Readonly<{ kind: 'environment'; environmentId: string;
            endpoint: string; expectStatus: number }>;
    keyword?: string;
}>;

export type HealthCheckFiniteLeafContextV1 = Readonly<{
    signal: AbortSignal;
    now(): number;
    /** The existing HTTP owner bound by P50 to this exact saved endpoint,
     * observer and network policy, including destination/redirect admission. */
    http: Pick<HttpService, 'request' | 'requestStream'>;
}>;

function nativeFailure(error: unknown, url: string): 'tls' | 'dns' | 'connection' | undefined {
    if (!(error instanceof Error)) return;
    const native = error.cause instanceof Error ? error.cause : error;
    if (!('code' in native) || typeof native.code !== 'string') return;
    if (isNativeTlsErrorCode(native.code, new URL(url).protocol === 'https:')) return 'tls';
    if (native.code === 'ENOTFOUND') return 'dns';
    // Reset/timeout may occur after headers while reading a keyword body;
    // those are incomplete evidence, not a proved connection refusal.
    if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(native.code)) {
        return 'connection';
    }
    return undefined;
}

function result(check: AdmittedHttpHealthCheckV1, kind: 'http' | 'certificate',
    context: HealthCheckFiniteLeafContextV1, startedAt: number, status: HealthCheckResultV1['status'],
    facts: Parameters<typeof finiteHealthCheckResult>[5]): HealthCheckResultV1 {
    const observedAt = context.now();
    return finiteHealthCheckResult(check, kind, observedAt, startedAt, status, facts);
}

async function observe(check: AdmittedHttpHealthCheckV1, context: HealthCheckFiniteLeafContextV1,
    kind: 'http' | 'certificate'): Promise<HealthCheckResultV1> {
    context.signal.throwIfAborted();
    const startedAt = context.now();
    const target = readHealthCheckHttpTargetV1(check.target);
    if (!target) return result(check, kind, context, startedAt, 'unknown', {
        reason: 'not_checked', disclosure: 'No HTTP health probe is configured',
        requiredFact: 'healthProbeEndpoint', remedy: 'Configure the check endpoint before running the health probe.',
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
        context.signal.throwIfAborted();
        // Authority/policy failures retain the transport's typed reason. A body
        // exceeding its existing budget is incomplete keyword evidence.
        if (isPluginError(error) && error.code !== 'plugin_fetch_response_too_large') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const failure = nativeFailure(error, url);
        if (failure === 'tls' || ((failure === 'connection' || failure === 'dns') && kind === 'http')) {
            return result(check, kind, context, startedAt, 'down', { reason: failure,
                requiredFact: failure === 'tls' ? 'validEndpointTlsConnection'
                    : failure === 'dns' ? 'resolvableHealthEndpoint' : 'reachableHealthEndpoint',
                remedy: failure === 'tls'
                    ? 'Check the endpoint TLS configuration, certificate chain, hostname and validity from the selected observer.'
                    : failure === 'dns' ? 'Check the endpoint DNS records from the selected observer.'
                    : 'Check endpoint DNS, service availability and network or firewall access from the selected observer.' });
        }
        logger.warnLocalFile('[Deployment health] HTTP observation incomplete',
            projectActionFailureCauseV1(error, `deployment.health.${kind}`, { allowUnknownErrorCode: false }));
        return result(check, kind, context, startedAt, 'unknown', { reason: 'transport_incomplete' });
    }
    context.signal.throwIfAborted();
    if (kind === 'http') {
        // Cloudflare's 521–526 family reports failure between its edge and the
        // origin (including origin TLS), rather than an application response.
        if (response.status >= 521 && response.status <= 526) {
            return result(check, kind, context, startedAt, 'down', { httpStatus: response.status, expectStatus,
                reason: 'cloudflare_origin_unavailable', providerCode: response.status, requiredFact: 'originServingResponse',
                disclosure: 'Cloudflare could not obtain the origin application response',
                remedy: 'Check origin availability, DNS, firewall rules and origin TLS configuration so Cloudflare can reach it and receive an HTTP response.' });
        }
        if (response.status === 403 && response.headers.server?.toLowerCase() === 'cloudflare'
            && /^error code: 1010(?:\s|$)/.test(errorPrefix)) {
            return result(check, kind, context, startedAt, 'down', { httpStatus: response.status, expectStatus,
                reason: 'cloudflare_browser_integrity', providerCode: 1010,
                disclosure: 'Cloudflare blocked the HTTP client signature; the application response was not observed',
                remedy: 'Review Cloudflare error 1010 guidance for this health client. Pages and workers.dev Browser Integrity Check cannot be disabled; other zones can adjust the blocking rule.' });
        }
        const statusMatched = deploymentDomainHealthStatusMatchesV1(response.status, expectStatus);
        const keywordMatched = check.keyword === undefined || new TextDecoder().decode(response.body).includes(check.keyword);
        return result(check, kind, context, startedAt, statusMatched && keywordMatched ? 'up' : 'down',
            { httpStatus: response.status, ...(expectStatus === undefined ? {} : { expectStatus }),
                ...(check.keyword === undefined ? {} : { keywordMatched }) });
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
