import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_PLUGIN_FETCH_REDIRECTS } from './redirect';
import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import { createGlobalFetchRuntime } from './globalFetchRuntime';
import { createPluginHttpService, createStablePluginHttpHost, type StablePluginHttpHostParams } from './service';

const servers: ReturnType<typeof createServer>[] = [];
// Admission used this DNS boundary; the platform transport owns ordinary DNS now.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) }));

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => void, hostname = '127.0.0.1') {
    const server = createServer(handle);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, hostname, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP listener required');
    return `http://${hostname}:${address.port}`;
}

function bind(origin: string, overrides: Partial<StablePluginHttpHostParams> = {}, otherOrigins: readonly string[] = [], privateNetwork = true, isCurrent: () => boolean = () => true) {
    const binding = createPluginInvocationServiceBinding('redirect-occurrence', 'redirect-binding');
    return createStablePluginHttpHost({ adapter: createGlobalFetchRuntime(), ...overrides }).bind({
        plugin: { id: 'acme.redirect', version: '1.0.0' },
        contribution: { id: 'read', qualifiedId: 'acme.redirect/actions/read' },
        occurrenceId: 'redirect-occurrence', correlationId: 'redirect-call', surface: 'agent',
        signal: new AbortController().signal, isOccurrenceCurrent: isCurrent,
    }, binding);
}

describe('plugin HTTP redirects through real transport', () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
        })));
    });

    it('follows a plain redirect with exactly one request per hop', async () => {
        const paths: string[] = [];
        const origin = await listen((request, response) => {
            paths.push(request.url!);
            if (request.url === '/start') response.writeHead(302, { location: '/result' }).end();
            else response.end('followed');
        });
        const response = await bind(origin).request({ url: `${origin}/start`, redirect: 'follow' });
        expect(new TextDecoder().decode(response.body)).toBe('followed');
        expect(response.finalUrl).toBe(`${origin}/result`);
        expect(paths).toEqual(['/start', '/result']);
    });

    it('retains metadata-only request intent through redirects', async () => {
        const paths: string[] = [];
        const origin = await listen((request, response) => {
            paths.push(request.url!);
            if (request.url === '/start') response.writeHead(302, { location: '/result' }).end('redirect body');
            else response.end('private final body');
        });
        const sent: unknown[] = [];
        const adapter = createGlobalFetchRuntime();
        const service = bind(origin, { adapter: { ...adapter, async request(request, options) {
            sent.push(request);
            return adapter.request(request, options);
        } } });
        const input = { url: `${origin}/start`, redirect: 'follow' as const,
            responseBody: 'discard' as const, observeTlsPeer: true as const };
        const result = await service.request(input);
        expect(result.status).toBe(200);
        expect(result.finalUrl).toBe(`${origin}/result`);
        expect(result.body.byteLength).toBe(0);
        expect(paths).toEqual(['/start', '/result']);
        expect(sent).toEqual([
            expect.objectContaining({ url: `${origin}/start`, responseBody: 'discard', observeTlsPeer: true }),
            expect.objectContaining({ url: `${origin}/result`, responseBody: 'discard', observeTlsPeer: true }),
        ]);
    });

    it('preserves peer metadata for admitted finite reads and refuses a newly bound retired invocation', async () => {
        let current = true;
        let retireDuringRead = false;
        const peer = { url: 'https://health.example.test/health', fingerprint256: 'AA:'.repeat(31) + 'AA',
            notBefore: 1_700_000_000_000, notAfter: 1_800_000_000_000 };
        const adapter = createGlobalFetchRuntime();
        // Genuine network boundary; native peer validation is covered by the transport's real TLS test.
        const service = bind('https://health.example.test', { adapter: { ...adapter,
            async request(input) {
                expect(input).toMatchObject({ responseBody: 'discard', observeTlsPeer: true });
                if (retireDuringRead) current = false;
                return { status: 200, finalUrl: input.url, headers: {}, body: new Uint8Array(), tlsPeer: peer };
            },
        } }, [], false, () => current);
        const input = { url: peer.url, redirect: 'manual' as const,
            responseBody: 'discard' as const, observeTlsPeer: true as const };
        expect(await service.request(input)).toMatchObject({ tlsPeer: peer });
        retireDuringRead = true;
        await expect(service.request(input)).resolves.toMatchObject({ tlsPeer: peer });
        await expect(service.request(input)).resolves.toMatchObject({ tlsPeer: peer });
        expect(() => bind('https://health.example.test', {}, [], false, () => current)).toThrowError(
            expect.objectContaining({ code: 'plugin_final_generation_retired' }));
    });

    it('snapshots finite metadata intent in a prepared read without sending HTTP during preparation', async () => {
        const paths: string[] = [];
        const origin = await listen((request, response) => {
            paths.push(request.url!);
            response.end('private response body');
        });
        const sent: unknown[] = [];
        const adapter = createGlobalFetchRuntime();
        const service = bind(origin, { adapter: { ...adapter, async request(request, options) {
            sent.push(request);
            return adapter.request(request, options);
        } } });
        const input = { intent: 'get' as const, url: `${origin}/health`, redirect: 'manual' as const,
            responseBody: 'discard' as 'discard' | 'buffer', observeTlsPeer: true as const };
        const prepared = await service.prepareRead(input);
        try {
            expect(paths).toEqual([]);
            input.responseBody = 'buffer';
            const result = await prepared.request({ signal: new AbortController().signal });
            expect(result.status).toBe(200);
            expect(result.body.byteLength).toBe(0);
            expect(paths).toEqual(['/health']);
            expect(sent).toEqual(expect.arrayContaining([
                expect.objectContaining({ responseBody: 'discard', observeTlsPeer: true }),
            ]));
        } finally {
            await prepared.dispose();
        }
    });

    it.each([302, 307])('follows a same-origin credential-bearing %s response with its credentials', async status => {
        const paths: string[] = [];
        let destination = '';
        const listener = await listen((request, response) => {
            paths.push(request.url!);
            if (request.url === '/ok' || request.url?.startsWith('/sink')) {
                expect(request.headers.authorization).toBe('Bearer selected');
                response.end('owner success');
            }
            else response.writeHead(status, { location: `${destination}/sink?private=location-secret` }).end();
        }, '0.0.0.0');
        const origin = listener.replace('0.0.0.0', '127.0.0.1');
        const other = listener.replace('0.0.0.0', '127.0.0.2');
        const service = bind(origin, {}, [other]);
        expect(await service.request({ url: `${origin}/ok`, headers: { Authorization: 'Bearer selected' }, redirect: 'follow' }))
            .toMatchObject({ status: 200 });
        destination = origin;
        expect(await service.request({ url: `${origin}/start`, method: 'POST',
            headers: { Authorization: 'Bearer selected' }, body: new TextEncoder().encode('private-body'), redirect: 'follow' }))
            .toMatchObject({ status: 200 });
        expect(paths).toEqual(['/ok', '/start', '/sink?private=location-secret']);
    });

    it('preserves explicit error-mode stream refusal without a retry or second hop', async () => {
        const paths: string[] = [];
        const origin = await listen((request, response) => {
            paths.push(request.url!);
            if (request.url === '/ok') response.end('owner stream');
            else response.writeHead(307, { location: '/sink' }).end();
        });
        const service = bind(origin, { retry: { maxAttempts: 3, baseDelayMs: 0 } });
        const stream = await service.requestStream({ url: `${origin}/ok`, headers: { Cookie: 'session=selected' }, redirect: 'error' });
        try {
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream.chunks) chunks.push(chunk);
            expect(Buffer.concat(chunks).toString()).toBe('owner stream');
        } finally { await stream.dispose(); }
        await expect(service.requestStream({ url: `${origin}/start`, headers: { Cookie: 'session=selected' }, redirect: 'error' }))
            .rejects.toMatchObject({ code: 'plugin_fetch_redirect_refused' });
        expect(paths).toEqual(['/ok', '/start']);
    });

    it.each([301, 302, 303, 307, 308])('uses fetch method and body semantics for %s', async status => {
        const received: { method?: string; body: string; contentType?: string }[] = [];
        const origin = await listen(async (request, response) => {
            if (request.url === '/start') { response.writeHead(status, { location: '/result' }).end(); return; }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push({ method: request.method, body: Buffer.concat(chunks).toString(), contentType: request.headers['content-type'] });
            response.end('ok');
        });
        await bind(origin).request({ url: `${origin}/start`, method: 'POST', body: new TextEncoder().encode('payload'),
            headers: { 'Content-Type': 'text/plain' }, redirect: 'follow' });
        expect(received).toEqual([{ method: status === 307 || status === 308 ? 'POST' : 'GET',
            body: status === 307 || status === 308 ? 'payload' : '', contentType: status === 307 || status === 308 ? 'text/plain' : undefined }]);
    });

    it('drops host-bound private credential headers on a cross-origin redirect', async () => {
        const received: (string | undefined)[] = [];
        const other = await listen((request, response) => { received.push(request.headers['x-api-key'] as string | undefined); response.end('ok'); });
        const origin = await listen((_request, response) => response.writeHead(307, { location: other }).end());
        const service = createPluginHttpService({ adapter: createGlobalFetchRuntime(),
            readPrivateCredentialHeaderNames: () => new Set(['x-api-key']) });
        await expect(service.request({ url: origin, headers: { 'X-Api-Key': 'bound-key', Authorization: 'Bearer selected' }, redirect: 'follow' }))
            .resolves.toMatchObject({ status: 200 });
        expect(received).toEqual([undefined]);
    });

    it('treats privateNetwork as disclosure and performs no admission DNS reads per call or redirect', async () => {
        vi.mocked(lookup).mockClear();
        let requests = 0;
        const origin = await listen((request, response) => {
            requests += 1;
            if (request.url === '/start') response.writeHead(302, { location: '/next' }).end();
            else response.end('local');
        }, 'localhost');
        const service = bind(origin, {}, [], false);
        const response = await service.request({ url: `${origin}/start`, redirect: 'follow' });
        expect(response.status).toBe(200);
        expect(requests).toBe(2);
        expect(lookup).not.toHaveBeenCalled();
    });

    it('follows a trusted plugin redirect outside manifest origin metadata', async () => {
        let destinationRequests = 0;
        const other = await listen((_request, response) => { destinationRequests += 1; response.end('followed'); });
        const origin = await listen((_request, response) => response.writeHead(302, { location: other }).end());
        await expect(bind(origin).request({ url: origin, redirect: 'follow' }))
            .resolves.toMatchObject({ status: 200, finalUrl: other + '/' });
        expect(destinationRequests).toBe(1);
    });

    it('keeps default redirect following independent of manifest origin metadata', async () => {
        let undeclaredRequests = 0;
        const other = await listen((_request, response) => { undeclaredRequests += 1; response.end('undeclared'); });
        const origin = await listen((_request, response) => response.writeHead(302, { location: other }).end());
        const service = bind(origin);
        // JavaScript plugin ingress can omit the SDK's required redirect field.
        await expect(Reflect.apply(service.request, service, [{ url: origin }]))
            .resolves.toMatchObject({ status: 200 });
        expect(undeclaredRequests).toBe(1);
    });

    it('keeps manual redirects and error mode without issuing the next request', async () => {
        let requests = 0;
        const origin = await listen((_request, response) => { requests += 1; response.writeHead(302, { location: '/result' }).end(); });
        const service = bind(origin);
        const manual = await service.request({ url: origin, redirect: 'manual' });
        expect(manual.status).toBe(302);
        expect(manual.headers.location).toBe('/result');
        await expect(service.request({ url: origin, redirect: 'error' })).rejects.toThrow();
        expect(requests).toBe(2);
    });

    it('uses the single host redirect bound and stops a loop', async () => {
        let requests = 0;
        const origin = await listen((_request, response) => { requests += 1; response.writeHead(302, { location: '/' }).end(); });
        await expect(bind(origin).request({ url: origin, redirect: 'follow' })).rejects.toThrow();
        expect(requests).toBe(MAX_PLUGIN_FETCH_REDIRECTS + 1);
    });
});
