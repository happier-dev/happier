import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createRequire } from 'node:module';
import { setImmediate as nextIoTurn } from 'node:timers/promises';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalFetchRuntime } from './globalFetchRuntime';
import { createPluginHttpService } from './service';
import { createEphemeralTlsServerFixture } from '../../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

const STABLE_RESPONSE_BODY_CEILING_BYTES = 32 * 1024 * 1024;
const servers: ReturnType<typeof createServer>[] = [];
// Genuine clock boundary: Undici exposes its coarse HTTP timer clock for tests.
const httpClock: { tick(delay?: number): void } = createRequire(import.meta.url)('undici/lib/util/timers.js');

function createTrackedStream(chunks: readonly Uint8Array[]) {
    let pullCount = 0;
    let cancelled = false;
    let cancellationReason: unknown;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = chunks[pullCount];
            pullCount += 1;
            if (chunk) {
                controller.enqueue(chunk);
            } else {
                controller.close();
            }
        },
        cancel(reason) {
            cancelled = true;
            cancellationReason = reason;
        },
    }, { highWaterMark: 0 });
    return {
        body,
        getCancellationReason: () => cancellationReason,
        wasCancelled: () => cancelled,
        getPullCount: () => pullCount,
    };
}

describe('createGlobalFetchRuntime', () => {
    afterEach(async () => {
        vi.unstubAllGlobals();
        await Promise.all(servers.splice(0).map(async (server) => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }));
    });

    it('releases a metadata-only response without pulling any response-body bytes', async () => {
        const tracked = createTrackedStream([new TextEncoder().encode('private response body')]);
        // Genuine network boundary: only status and peer metadata are consumed.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(tracked.body, { status: 200 })));
        const request = { url: 'https://health.example.test/health', redirect: 'manual' as const,
            responseBody: 'discard' as const };
        const result = await createGlobalFetchRuntime().request(request);
        expect(result.status).toBe(200);
        expect(tracked.getPullCount()).toBe(0);
        expect(tracked.wasCancelled()).toBe(true);
        expect(result.body.byteLength).toBe(0);
    });

    it('observes the same validated public-name TLS peer and rejects wrong names or untrusted chains before HTTP', async () => {
        const fixture = await createEphemeralTlsServerFixture();
        const defaultCAs = getCACertificates('default');
        const certificate = new X509Certificate(await readFile(fixture.leafCertificatePath));
        let requests = 0;
        let publicHost: string | undefined;
        let publicSni: string | undefined;
        const tlsMaterial = { key: await readFile(fixture.privateKeyPath), cert: await readFile(fixture.leafCertificatePath) };
        const server = createHttpsServer(tlsMaterial, (request, response) => {
            requests += 1;
            publicHost = request.headers.host;
            publicSni = 'servername' in request.socket
                ? String(request.socket.servername) : undefined;
            response.end('private response body');
        });
        const wrongNameServer = createHttpsServer(tlsMaterial, (_request, response) => {
            requests += 1;
            response.end('wrong-name response');
        });
        try {
            setDefaultCACertificates([...defaultCAs, await readFile(fixture.caCertificatePath, 'utf8')]);
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            await new Promise<void>(resolve => wrongNameServer.listen(0, '127.0.0.2', resolve));
            const address = server.address();
            const wrongNameAddress = wrongNameServer.address();
            if (!address || typeof address === 'string' || !wrongNameAddress || typeof wrongNameAddress === 'string') throw new Error('TLS TCP listener required');
            const url = `https://localhost:${address.port}/health`;
            const request = { url, redirect: 'manual' as const, responseBody: 'discard' as const,
                observeTlsPeer: true as const };
            const result = await createGlobalFetchRuntime().request(request);
            expect(result).toMatchObject({ status: 200, tlsPeer: { url,
                fingerprint256: certificate.fingerprint256, notBefore: Date.parse(certificate.validFrom),
                notAfter: Date.parse(certificate.validTo) } });
            expect(result.body.byteLength).toBe(0);
            expect(publicHost).toBe(`localhost:${address.port}`);
            expect(publicSni).toBe('localhost');
            expect(await createGlobalFetchRuntime().request(request)).toMatchObject({ tlsPeer: {
                url, fingerprint256: certificate.fingerprint256, notBefore: Date.parse(certificate.validFrom),
                notAfter: Date.parse(certificate.validTo),
            } });
            await expect(createGlobalFetchRuntime().request({ ...request, url: `https://127.0.0.2:${wrongNameAddress.port}/health` }))
                .rejects.toMatchObject({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
            expect(requests).toBe(2);
            await expect(createGlobalFetchRuntime().request({ ...request,
                url: `https://127.0.0.2:${wrongNameAddress.port}/health`, headers: { Host: 'localhost' },
            })).rejects.toMatchObject({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
            expect(requests).toBe(2);
            setDefaultCACertificates(defaultCAs);
            await expect(createGlobalFetchRuntime().request(request)).rejects.toBeDefined();
            expect(requests).toBe(2);
        } finally {
            setDefaultCACertificates(defaultCAs);
            server.closeAllConnections();
            wrongNameServer.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await new Promise<void>(resolve => wrongNameServer.close(() => resolve()));
            await fixture.cleanup();
        }
    });

    it('cancels a TLS metadata read stalled before its handshake', async () => {
        let accept!: () => void;
        const accepted = new Promise<void>(resolve => { accept = resolve; });
        let peer: import('node:net').Socket | undefined;
        const server = createTcpServer(socket => { peer = socket; accept(); });
        const cancellation = new AbortController();
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('TCP listener required');
            const request = { url: `https://127.0.0.1:${address.port}/health`, redirect: 'manual' as const,
                responseBody: 'discard' as const, observeTlsPeer: true as const };
            const result = createGlobalFetchRuntime().request(request, { signal: cancellation.signal });
            const settled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
            await accepted;
            cancellation.abort();
            await settled;
        } finally {
            cancellation.abort();
            peer?.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('reads a stream only on demand and retains no body read after disposal', async () => {
        const tracked = createTrackedStream([new TextEncoder().encode('first'), new TextEncoder().encode('later')]);
        // Genuine network boundary; a declared total length is not a buffered-body limit for a stream.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(tracked.body, {
            headers: { 'content-length': String(STABLE_RESPONSE_BODY_CEILING_BYTES + 1) },
        })));
        const stream = await createGlobalFetchRuntime().requestStream!({ url: 'https://logs.example/read', redirect: 'error' });
        expect(tracked.getPullCount()).toBe(0);
        const iterator = stream.chunks[Symbol.asyncIterator]();
        expect(new TextDecoder().decode((await iterator.next()).value)).toBe('first');
        expect(tracked.getPullCount()).toBe(1);
        await stream.dispose();
        expect((await iterator.next()).done).toBe(true);
        expect(tracked.getPullCount()).toBe(1);
        expect(tracked.getCancellationReason()).toBeDefined();
    });

    it.each([
        { phase: 'headers', outcome: 'complete' },
        { phase: 'body', outcome: 'complete' },
        { phase: 'headers', outcome: 'cancel' },
        { phase: 'body', outcome: 'cancel' },
    ] as const)('keeps delayed $phase under the operation lifetime and can $outcome after 300 seconds', async ({ phase, outcome }) => {
        const previousDispatcher = getGlobalDispatcher();
        // Default Client header/body deadlines are 300 seconds. Using the
        // package dispatcher makes their actual clock controllable, not HTTP IO.
        const ambient = new Agent();
        setGlobalDispatcher(ambient);
        let arrived!: () => void;
        const arrival = new Promise<void>(resolve => { arrived = resolve; });
        let nativeResponse: import('node:http').ServerResponse | undefined;
        let requests = 0;
        const server = createServer((request, response) => {
            requests += 1;
            request.resume();
            request.on('end', () => {
                nativeResponse = response;
                if (phase === 'body') response.write('accepted:');
                arrived();
            });
        });
        const cancellation = new AbortController();
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing loopback address');
            const service = createPluginHttpService({ adapter: createGlobalFetchRuntime() });
            const result = service.request({
                url: `http://127.0.0.1:${address.port}/native/pull`, method: 'POST', redirect: 'error',
            }, { signal: cancellation.signal }).then(value => ({ value }), error => ({ error }));
            await arrival;
            // Let the client parse body headers before advancing its idle clock.
            await nextIoTurn();
            await nextIoTurn();
            httpClock.tick();
            httpClock.tick(301_000);
            await nextIoTurn();
            if (outcome === 'cancel') cancellation.abort();
            else nativeResponse!.end('completed');
            const settled = await result;
            if (outcome === 'cancel') {
                expect(settled).toMatchObject({ error: { name: 'AbortError' } });
            } else {
                expect(settled).toMatchObject({ value: { status: 200 } });
                if (!('value' in settled)) throw settled.error;
                expect(new TextDecoder().decode(settled.value.body)).toBe(phase === 'body' ? 'accepted:completed' : 'completed');
            }
            expect(requests).toBe(1);
        } finally {
            cancellation.abort();
            setGlobalDispatcher(previousDispatcher);
            await ambient.destroy();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('delivers a plugin DELETE body through the real transport', async () => {
        const body = new TextEncoder().encode('{"members":["qa-user"]}');
        let receivedBody = '';
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            receivedBody = Buffer.concat(chunks).toString('utf8');
            response.end('ok');
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');
        const response = await createGlobalFetchRuntime().request({
            url: `http://127.0.0.1:${address.port}/members`,
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body,
            redirect: 'error',
        });
        expect(response.status).toBe(200);
        expect(receivedBody).toBe(new TextDecoder().decode(body));
    });

    it('preserves a conditional 304 and its headers through the real transport without following or retrying', async () => {
        let requests = 0;
        const server = createServer((request, response) => {
            requests += 1;
            response.setHeader('etag', '"runs-v1"');
            response.setHeader('x-ratelimit-remaining', '4818');
            response.setHeader('x-ratelimit-reset', '1793011679');
            response.setHeader('x-ratelimit-resource', 'core');
            if (request.headers['if-none-match'] === '"runs-v1"') {
                response.writeHead(304).end();
            } else {
                response.end('{"workflow_runs":[]}');
            }
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');
        const runtime = createGlobalFetchRuntime();
        const input = { url: `http://127.0.0.1:${address.port}/runs`, method: 'GET' as const, redirect: 'error' as const };
        const initial = await runtime.request(input);
        expect(initial.status).toBe(200);
        const conditional = await runtime.request({ ...input, headers: { 'If-None-Match': initial.headers.etag! } });
        expect(conditional.status).toBe(304);
        expect(conditional.headers).toMatchObject({ etag: '"runs-v1"', 'x-ratelimit-remaining': '4818',
            'x-ratelimit-reset': '1793011679', 'x-ratelimit-resource': 'core' });
        expect(conditional.body.byteLength).toBe(0);
        expect(requests).toBe(2);
    });

    it('passes manual redirect mode to the system boundary and exposes the 3xx response', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { location: 'https://next.example.test/result' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await createGlobalFetchRuntime().request({
            url: 'https://api.example.test/start',
            redirect: 'manual',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/start',
            expect.objectContaining({ redirect: 'manual' }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('https://next.example.test/result');
        expect(response.body.byteLength).toBe(0);
    });

    it('stops consuming an oversized streamed response before pulling another chunk', async () => {
        const body = createTrackedStream([
            new Uint8Array(STABLE_RESPONSE_BODY_CEILING_BYTES),
            new Uint8Array([1]),
            new Uint8Array([2]),
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body.body)));

        let error: unknown;
        try {
            await createGlobalFetchRuntime().request({
                url: 'https://api.example.test/oversized',
                redirect: 'error',
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });

        expect(body.getPullCount()).toBe(2);
        expect(body.getCancellationReason()).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
    });

    it('cancels a known oversized body before its first chunk is pulled', async () => {
        const body = createTrackedStream([new Uint8Array([1])]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body.body, {
            headers: { 'content-length': String(STABLE_RESPONSE_BODY_CEILING_BYTES + 1) },
        })));

        let error: unknown;
        try {
            await createGlobalFetchRuntime().request({
                url: 'https://api.example.test/known-oversized',
                redirect: 'error',
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
        expect(body.getPullCount()).toBe(0);
        expect(body.getCancellationReason()).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
    });

    it('returns a response exactly at the buffered ceiling when content length is absent', async () => {
        const expected = new Uint8Array(STABLE_RESPONSE_BODY_CEILING_BYTES);
        expected[0] = 1;
        expected[expected.byteLength - 1] = 2;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(createTrackedStream([expected]).body)));

        const response = await createGlobalFetchRuntime().request({
            url: 'https://api.example.test/at-limit',
            redirect: 'error',
        });

        expect(response.body).toBeInstanceOf(Uint8Array);
        expect(response.body.byteLength).toBe(STABLE_RESPONSE_BODY_CEILING_BYTES);
        expect(response.body[0]).toBe(1);
        expect(response.body[response.body.byteLength - 1]).toBe(2);
    });

    it('propagates caller abort to an in-flight streamed response', async () => {
        const cancellation = new AbortController();
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let resolvePullStarted: (() => void) | undefined;
        const pullStarted = new Promise<void>((resolve) => {
            resolvePullStarted = resolve;
        });
        let receivedSignal: AbortSignal | null | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller;
            },
            pull() {
                resolvePullStarted?.();
                return new Promise<void>(() => undefined);
            },
        }, { highWaterMark: 0 });
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            receivedSignal = init?.signal;
            receivedSignal?.addEventListener('abort', () => {
                const error = new Error('request aborted');
                error.name = 'AbortError';
                streamController?.error(error);
            }, { once: true });
            return new Response(body);
        }));

        const pending = createGlobalFetchRuntime().request({
            url: 'https://api.example.test/slow',
            redirect: 'error',
        }, { signal: cancellation.signal });
        await pullStarted;
        cancellation.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(receivedSignal?.aborted).toBe(true);
    });
});
