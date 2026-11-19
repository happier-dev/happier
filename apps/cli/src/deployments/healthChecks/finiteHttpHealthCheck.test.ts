import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/deployments/contracts/v1';
import { HealthCheckResultV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginHttpService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { logger } from '@/ui/logger';
import { readHttpHealthCheckV1, readCertificateHealthCheckV1,
    type AdmittedHttpHealthCheckV1, type HealthCheckFiniteLeafContextV1 } from './finiteHttpHealthCheck';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

// Genuine network boundary, matching the fetch runtime suite: preserve native
// Agent/TLS and real fetch unless a test supplies a response stream.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});
function stubFetch(fetchBoundary: typeof globalThis.fetch) {
    vi.stubGlobal('fetch', fetchBoundary);
    // Node and Bun expose different Fetch type declarations at this boundary.
    vi.mocked(undici.fetch).mockImplementation(fetchBoundary as unknown as typeof undici.fetch);
}

const servers: ReturnType<typeof createServer>[] = [];
async function endpoint(handle: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handle);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP listener required');
    return `http://127.0.0.1:${address.port}/health`;
}
function admitted(url: string) {
    return { sourceInstanceId: 'saved-source', checkId: 'http',
        subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'watched-service' },
        observer: { machineId: 'observer-machine', installationId: 'observer-installation' }, vantage: 'outside',
        target: { kind: 'machineService', machineId: 'service-machine', serviceId: 'watched-service',
            endpoint: url, expectStatus: 200 } } satisfies AdmittedHttpHealthCheckV1;
}
function context(url: string, overrides: Partial<HealthCheckFiniteLeafContextV1> = {}): HealthCheckFiniteLeafContextV1 {
    return { signal: new AbortController().signal, now: () => 1_800_000_000_000,
        http: createPluginHttpService({ adapter: createGlobalFetchRuntime() }),
        ...overrides };
}

describe('finite saved HTTP and certificate health', () => {
    it('keeps authored diagnostic causes recursively closed and validates known fields', () => {
        const value = { status: 'down', observedAt: 10, cause: { kind: 'http', vantage: 'outside',
            observerMachineId: 'observer', httpStatus: 503, futureDiagnostic: 'not executable' },
            evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' }, author: { kind: 'process' }, text: 'HTTP check failed.' }] } };
        expect(HealthCheckResultV1Schema.safeParse(value).success).toBe(false);
        expect(HealthCheckResultV1ProtocolSchema.safeParse(value).success).toBe(false);
        const { futureDiagnostic: _future, ...cause } = value.cause;
        const known = { ...value, cause };
        expect(HealthCheckResultV1Schema.safeParse(known).success).toBe(true);
        expect(HealthCheckResultV1Schema.safeParse({ ...known, cause: { ...cause, httpStatus: '503' } }).success).toBe(false);
        expect(HealthCheckResultV1ProtocolSchema.safeParse({ ...known, cause: { ...cause, httpStatus: '503' } }).success).toBe(false);
        expect(HealthCheckResultV1Schema.safeParse({ ...known, unexpectedResultField: true }).success).toBe(false);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.mocked(undici.fetch).mockReset().mockImplementation((await vi.importActual<typeof import('undici')>('undici')).fetch);
        await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
            server.closeAllConnections(); server.close(() => resolve());
        })));
    });

    it('checks a watched service without Environment custody and emits only canonical metadata', async () => {
        let requests = 0;
        const url = await endpoint((_request, response) => { requests += 1; response.end('private-body-sentinel'); });
        const check = admitted(url);
        const result = HealthCheckResultV1Schema.parse(await readHttpHealthCheckV1(check, context(url)));
        expect(result.status).toBe('up');
        expect(result).toMatchObject({ cause: { kind: 'http', httpStatus: 200, expectStatus: 200,
            vantage: 'outside', observerMachineId: 'observer-machine' } });
        expect(requests).toBe(1);
        expect(JSON.stringify(result)).not.toContain('private-body-sentinel');
        expect(JSON.stringify(result)).not.toContain(url);
        expect(result.evidence.items[0]?.text).not.toContain('"httpStatus"');
        expect((await readHttpHealthCheckV1({ ...check,
            target: { ...admitted(url).target, expectStatus: 201 } }, context(url))).status).toBe('down');
        expect(requests).toBe(2);
    });

    it('treats any answer below 500 as reachable when no status is expected, and 502 as down', async () => {
        let status = 302;
        const url = await endpoint((_request, response) => { response.statusCode = status; response.end(); });
        const { expectStatus: _exact, ...target } = admitted(url).target;
        const check = { ...admitted(url), target };
        for (const [answer, verdict] of [[302, 'up'], [404, 'up'], [502, 'down']] as const) {
            status = answer;
            const result = HealthCheckResultV1Schema.parse(await readHttpHealthCheckV1(check, context(url)));
            expect(result.status).toBe(verdict);
            expect(result.cause).toMatchObject({ httpStatus: answer });
            expect(result.cause).not.toHaveProperty('expectStatus');
        }
    });
    it('identifies the health client on the wire instead of inheriting the HTTP library signature', async () => {
        let userAgent: string | undefined;
        const url = await endpoint((request, response) => { userAgent = request.headers['user-agent']; response.end(); });
        expect((await readHttpHealthCheckV1(admitted(url), context(url))).status).toBe('up');
        expect(userAgent).toMatch(/Happier/i);
    });

    it('explains a Cloudflare 1010 without disclosing the response or misclassifying an ordinary 403', async () => {
        let body = 'error code: 1010\n';
        const url = await endpoint((_request, response) => response.writeHead(403, { server: 'cloudflare' }).end(body));
        for (const keyword of [undefined, 'private-keyword']) {
            const result = HealthCheckResultV1Schema.parse(await readHttpHealthCheckV1({ ...admitted(url),
                ...(keyword === undefined ? {} : { keyword }) }, context(url)));
            expect(result.status).toBe('down');
            expect(result.cause).toMatchObject({ httpStatus: 403,
                reason: 'cloudflare_browser_integrity', providerCode: 1010,
                disclosure: expect.stringMatching(/client.*signature/i), remedy: expect.stringMatching(/Cloudflare/i) });
            expect(JSON.stringify(result)).not.toContain('private-keyword');
        }
        for (const ordinaryBody of ['private-forbidden-response', 'error code: 10101']) {
            body = ordinaryBody;
            const ordinary = await readHttpHealthCheckV1({ ...admitted(url),
                target: { ...admitted(url).target, expectStatus: 403 } }, context(url));
            expect(ordinary.status).toBe('up');
            expect(ordinary.cause).not.toHaveProperty('providerCode');
            expect(JSON.stringify(ordinary)).not.toContain(body);
        }
    });

    it('explains Cloudflare origin connection and TLS refusals without treating an expected proxy error as application health', async () => {
        let status = 522;
        const url = await endpoint((_request, response) => response.writeHead(status, { server: 'cloudflare' }).end('private-origin-error'));
        for (const originStatus of [521, 522, 523, 524, 525, 526]) {
            status = originStatus;
            const check = admitted(url);
            const observed = HealthCheckResultV1Schema.parse(await readHttpHealthCheckV1(check, context(url)));
            expect(observed.status).toBe('down');
            expect(observed.cause).toMatchObject({
                httpStatus: originStatus, providerCode: originStatus, reason: 'cloudflare_origin_unavailable',
                requiredFact: 'originServingResponse', remedy: expect.any(String),
            });
            expect(JSON.stringify(observed)).not.toContain('private-origin-error');
        }
        status = 522;
        const check = admitted(url);
        expect((await readHttpHealthCheckV1({ ...check,
            target: { ...check.target, expectStatus: 522 } }, context(url))).status).toBe('down');
        for (const ordinaryStatus of [520, 503]) {
            status = ordinaryStatus;
            const check = admitted(url);
            const observed = await readHttpHealthCheckV1({ ...check,
                target: { ...check.target, expectStatus: ordinaryStatus } }, context(url));
            expect(observed.status).toBe('up');
            expect(observed.cause).not.toHaveProperty('providerCode');
        }
    });

    it('reads response bytes only for keyword checks, and never discloses the keyword or body', async () => {
        let pulls = 0;
        const url = 'https://service.example/health';
        stubFetch(async () => new Response(new ReadableStream<Uint8Array>({
            pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode('private-keyword-sentinel')); controller.close(); },
        }, { highWaterMark: 0 })));
        expect((await readHttpHealthCheckV1(admitted(url), context(url))).status).toBe('up');
        expect(pulls).toBe(0);
        const result = await readHttpHealthCheckV1({ ...admitted(url), keyword: 'keyword-sentinel' }, context(url));
        expect(result.status).toBe('up');
        expect(pulls).toBe(1);
        expect(JSON.stringify(result)).not.toContain('sentinel');
        expect((await readHttpHealthCheckV1({ ...admitted(url), keyword: 'absent' }, context(url))).status).toBe('down');
    });

    it('keeps incomplete keyword evidence unknown instead of claiming the keyword is absent', async () => {
        const url = 'https://service.example/health';
        stubFetch(async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.error(Object.assign(new Error('private-response-error'), { code: 'ECONNRESET' })); },
        })));
        const result = await readHttpHealthCheckV1({ ...admitted(url), keyword: 'needle' }, context(url));
        expect(result.status).toBe('unknown');
        expect(JSON.stringify(result)).not.toContain('private-response-error');
    });

    it('keeps certificate capture absence independent from successful HTTP and reads no body', async () => {
        const url = 'https://service.example/health';
        let pulls = 0;
        stubFetch(async () => new Response(new ReadableStream<Uint8Array>({
            pull(controller) { pulls += 1; controller.close(); },
        }, { highWaterMark: 0 })));
        const f = context(url);
        expect((await readHttpHealthCheckV1(admitted(url), f)).status).toBe('up');
        expect((await readCertificateHealthCheckV1(admitted(url), f)).status).toBe('unknown');
        expect(pulls).toBe(0);
    });

    it('reports native certificate validity independently of HTTP status and rejects untrusted peers without HTTP', async () => {
        const fixture = await createEphemeralTlsServerFixture();
        const defaultCAs = getCACertificates('default');
        let requests = 0;
        const server = createHttpsServer({ key: await readFile(fixture.privateKeyPath),
            cert: await readFile(fixture.leafCertificatePath) }, (_request, response) => {
            requests += 1; response.writeHead(401).end('private-auth-body');
        });
        try {
            setDefaultCACertificates([...defaultCAs, await readFile(fixture.caCertificatePath, 'utf8')]);
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('TLS listener required');
            // A saved URL may omit the root slash or include a client fragment.
            // The native owner's same-request peer remains certificate evidence.
            const url = `https://localhost:${address.port}#check`;
            const f = context(url, { now: Date.now });
            const valid = await readCertificateHealthCheckV1(admitted(url), f);
            setDefaultCACertificates(defaultCAs);
            const nativeFetch = globalThis.fetch;
            let failureCode = 'unobserved';
            // Observe the genuine native TLS boundary without replacing its
            // validation. Only the closed native code enters the assertion.
            vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
                try { return await nativeFetch(input, init); }
                catch (error) {
                    const cause = error instanceof Error ? error.cause : undefined;
                    if (cause && typeof cause === 'object' && 'code' in cause) failureCode = String(cause.code);
                    throw error;
                }
            });
            const invalid = await readCertificateHealthCheckV1(admitted(url), f);
            expect({ valid: HealthCheckResultV1Schema.parse(valid).status, invalid: invalid.status },
                `Native TLS refusal: ${failureCode}`).toEqual({ valid: 'up', invalid: 'down' });
            expect(invalid.cause).toMatchObject({
                reason: 'tls', requiredFact: 'validEndpointTlsConnection', remedy: expect.any(String),
            });
            expect(valid.cause?.fingerprint256).toBeTruthy();
            expect(JSON.stringify(valid)).not.toContain('private-auth-body');
            expect(requests).toBe(1);
        } finally {
            setDefaultCACertificates(defaultCAs);
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await fixture.cleanup();
        }
    });

    it('reports a refused native connection as an observed HTTP failure', async () => {
        const server = createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        await new Promise<void>(resolve => server.close(() => resolve()));
        const url = `http://127.0.0.1:${address.port}/health`;
        const refused = await readHttpHealthCheckV1(admitted(url), context(url));
        expect(refused.status).toBe('down');
        expect(refused.cause).toMatchObject({
            reason: 'connection', requiredFact: 'reachableHealthEndpoint', remedy: expect.any(String),
        });
        // A connection failure has no certificate evidence of its own.
        expect((await readCertificateHealthCheckV1(admitted(url), context(url))).status).toBe('unknown');
        // The network adapter boundary also exposes the native DNS failure seen
        // when a previously observed Pages hostname no longer resolves.
        stubFetch(async () => { throw new TypeError('private-transport-message', {
            cause: Object.assign(new Error('private-hostname'), { code: 'ENOTFOUND' }),
        }); });
        const unresolved = await readHttpHealthCheckV1(admitted(url), context(url));
        expect(unresolved.status).toBe('down');
        expect(unresolved.cause).toMatchObject({
            reason: 'dns', requiredFact: 'resolvableHealthEndpoint', remedy: expect.any(String),
        });
        expect(JSON.stringify(unresolved)).not.toContain('private-');
    });

    it('keeps a temporary resolver failure unavailable rather than claiming outside DNS failure', async () => {
        const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const url = 'https://service.example/health';
        stubFetch(async () => { throw new TypeError('private-transport-message', {
            cause: Object.assign(new Error('private-resolver'), { code: 'EAI_AGAIN' }),
        }); });
        const observed = await readHttpHealthCheckV1(admitted(url), context(url));
        expect(observed.status).toBe('unknown');
        expect(observed.cause).toMatchObject({ reason: 'transport_incomplete' });
        expect(JSON.stringify(observed)).not.toContain('private-');
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'deployment.health.http', errorClass: 'TypeError', errorCode: 'EAI_AGAIN',
        }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
    });

    it('keeps the Domain public authority and expected authentication challenge with same-Machine disclosure', async () => {
        const seen: string[] = [];
        stubFetch(async (url) => { seen.push(String(url)); return new Response(null, { status: 401 }); });
        const check: AdmittedHttpHealthCheckV1 = { sourceInstanceId: 'domain-source', checkId: 'domain-http',
            subject: { kind: 'environment', environmentId: 'environment' },
            observer: { machineId: 'ingress-machine', installationId: 'ingress-installation' }, vantage: 'sameMachine',
            target: { kind: 'domain', environmentId: 'environment', targetLinkId: 'link', domainId: 'domain',
                domainRevision: 2, targetLinkRevision: 3, hostname: 'public.example',
                healthCheck: { path: '//health', expectStatus: 401 } } };
        const result = await readHttpHealthCheckV1(check, context('https://public.example'));
        expect(result.status).toBe('up');
        expect(seen).toEqual(['https://public.example//health']);
        expect(result.cause?.disclosure).toContain('checked from the server itself');
    });

    it('reports absent Domain probes as unknown without sending HTTP or certificate requests', async () => {
        let requests = 0;
        // The HTTP transport is the external boundary; retain the real finite observer.
        const unavailable = async () => {
            requests += 1;
            throw new Error('Transport observation unavailable');
        };
        const observation = context('https://public.example', { http: { request: unavailable, requestStream: unavailable } });
        const check: AdmittedHttpHealthCheckV1 = { sourceInstanceId: 'domain-source', checkId: 'domain-http',
            subject: { kind: 'environment', environmentId: 'environment' },
            observer: { machineId: 'observer', installationId: 'installation' }, vantage: 'outside',
            target: { kind: 'domain', environmentId: 'environment', targetLinkId: 'link', domainId: 'domain',
                domainRevision: 1, targetLinkRevision: 1, hostname: 'public.example' } };
        for (const read of [readHttpHealthCheckV1, readCertificateHealthCheckV1]) {
            const observed = await read(check, observation);
            expect(observed.status).toBe('unknown');
            expect(observed.cause).toMatchObject({
                reason: 'not_checked', requiredFact: 'healthProbeEndpoint',
                remedy: expect.stringMatching(/configure.*endpoint/i),
            });
        }
        expect(requests).toBe(0);
        if (check.target.kind !== 'domain') throw new Error('Expected Domain');
        await readHttpHealthCheckV1({ ...check, target: { ...check.target,
            healthCheck: { path: '/ready', expectStatus: 204 } } }, observation);
        expect(requests).toBe(1);
    });

    it('cancels before I/O and suppresses observations cancelled during I/O', async () => {
        let requests = 0;
        let active = new AbortController();
        const url = await endpoint((_request, response) => {
            requests += 1;
            active.abort();
            response.end('healthy');
        });
        for (const read of [readHttpHealthCheckV1, readCertificateHealthCheckV1]) {
            const cancelled = new AbortController(); cancelled.abort();
            await expect(read(admitted(url), context(url, { signal: cancelled.signal })))
                .rejects.toMatchObject({ name: 'AbortError' });
        }
        expect(requests).toBe(0);
        for (const read of [readHttpHealthCheckV1, readCertificateHealthCheckV1]) {
            active = new AbortController();
            await expect(read(admitted(url), context(url, { signal: active.signal })))
                .rejects.toMatchObject({ name: 'AbortError' });
        }
        expect(requests).toBe(2);
    });

    it('preserves transport policy refusals rather than converting lost authority to an outage', async () => {
        const url = 'https://service.example/health';
        const error = new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired owner' });
        const http = createPluginHttpService({ adapter: { async request() { throw error; }, async requestStream() { throw error; } } });
        await expect(readHttpHealthCheckV1(admitted(url), context(url, { http }))).rejects.toBe(error);
    });
});
