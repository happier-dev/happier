import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginHttpService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
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
        isCurrent: async () => true,
        http: createPluginHttpService({ adapter: createGlobalFetchRuntime() }),
        ...overrides };
}

describe('finite saved HTTP and certificate health', () => {
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
        expect(requests).toBe(1);
        expect(JSON.stringify(result)).not.toContain('private-body-sentinel');
        expect(JSON.stringify(result)).not.toContain(url);
        expect(result.evidence.items[0]?.text).toContain('outside');
        expect((await readHttpHealthCheckV1({ ...check,
            target: { ...admitted(url).target, expectStatus: 201 } }, context(url))).status).toBe('down');
        expect(requests).toBe(2);
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
            expect(JSON.parse(result.evidence.items[0]?.text ?? '{}')).toMatchObject({ httpStatus: 403,
                reason: 'cloudflare_browser_integrity', providerCode: 1010,
                disclosure: expect.stringMatching(/client.*signature/i), remedy: expect.stringMatching(/Cloudflare/i) });
            expect(JSON.stringify(result)).not.toContain('private-keyword');
        }
        for (const ordinaryBody of ['private-forbidden-response', 'error code: 10101']) {
            body = ordinaryBody;
            const ordinary = await readHttpHealthCheckV1({ ...admitted(url),
                target: { ...admitted(url).target, expectStatus: 403 } }, context(url));
            expect(ordinary.status).toBe('up');
            expect(JSON.parse(ordinary.evidence.items[0]?.text ?? '{}')).not.toHaveProperty('providerCode');
            expect(JSON.stringify(ordinary)).not.toContain(body);
        }
    });

    it('requests body bytes only for keyword checks, and never discloses the keyword or body', async () => {
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
            expect(valid.evidence.items[0]?.text).toContain('fingerprint256');
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
        expect((await readHttpHealthCheckV1(admitted(url), context(url))).status).toBe('down');
        // A connection failure has no certificate evidence of its own.
        expect((await readCertificateHealthCheckV1(admitted(url), context(url))).status).toBe('unknown');
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
        expect(result.evidence.items[0]?.text).toContain('checked from the server itself');
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
            expect(observed.evidence.items[0]?.text).toContain('not_checked');
        }
        expect(requests).toBe(0);
        if (check.target.kind !== 'domain') throw new Error('Expected Domain');
        await readHttpHealthCheckV1({ ...check, target: { ...check.target,
            healthCheck: { path: '/ready', expectStatus: 204 } } }, observation);
        expect(requests).toBe(1);
    });

    it('refuses stale and cancelled checks before I/O and suppresses an observation retired during I/O', async () => {
        let requests = 0;
        const url = await endpoint((_request, response) => { requests += 1; response.end('healthy'); });
        await expect(readHttpHealthCheckV1(admitted(url), context(url, { isCurrent: async () => false })))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        const cancellation = new AbortController(); cancellation.abort();
        await expect(readHttpHealthCheckV1(admitted(url), context(url, { signal: cancellation.signal })))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).toBe(0);
        let reads = 0;
        await expect(readHttpHealthCheckV1(admitted(url), context(url, { isCurrent: async () => ++reads === 1 })))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(requests).toBe(1);
    });

    it('preserves transport policy refusals rather than converting lost authority to an outage', async () => {
        const url = 'https://service.example/health';
        const error = new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired owner' });
        const http = createPluginHttpService({ adapter: { async request() { throw error; }, async requestStream() { throw error; } } });
        await expect(readHttpHealthCheckV1(admitted(url), context(url, { http }))).rejects.toBe(error);
    });
});
