import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFetchPluginHttpRuntime } from './fetchTransport.js';
import { createPluginHttpService } from './service.js';
import { PluginError } from '../errors.js';

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    })));
});

async function listen(handler: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    return `http://127.0.0.1:${address.port}`;
}

describe.each(['request', 'requestStream'] as const)('%s Fetch acknowledgement', operation => {
    it.each(['disconnect', 'cancel'] as const)('keeps an accepted request uncertain after %s', async failure => {
        const cancellation = new AbortController();
        let accepted = false;
        const origin = await listen((request, _response) => {
            accepted = true;
            if (failure === 'cancel') cancellation.abort();
            else request.socket.destroy();
        });
        const runtime = createFetchPluginHttpRuntime(globalThis.fetch);
        await expect(runtime[operation]({ url: origin, method: operation === 'request' ? 'POST' : 'GET', redirect: 'error' },
            { signal: cancellation.signal })).rejects.toMatchObject({ code: 'outcome_unknown', data: {
                failureCause: { phase: 'plugin.http.execute' },
            } });
        expect(accepted).toBe(true);
    });

    it('preserves pre-dispatch cancellation and known transport refusals', async () => {
        const cancellation = new AbortController();
        cancellation.abort();
        let attempted = false;
        const refusal = new PluginError({ code: 'plugin_fetch_redirect_refused' });
        const runtime = createFetchPluginHttpRuntime(async () => { attempted = true; throw refusal; });
        await expect(runtime[operation]({ url: 'https://fixture.example.test', redirect: 'error' },
            { signal: cancellation.signal })).rejects.toBe(cancellation.signal.reason);
        expect(attempted).toBe(false);
        await expect(runtime[operation]({ url: 'https://fixture.example.test', redirect: 'error' })).rejects.toBe(refusal);
    });
});

it.each(['runtime', 'service'] as const)('preserves a completed portable native response after final-read cancellation (%s)', async owner => {
    const expected = new TextEncoder().encode('{"resourceId":"created-portable-resource"}');
    let requests = 0;
    const origin = await listen((_request, response) => {
        requests += 1;
        response.writeHead(201, { 'content-type': 'application/json', 'x-native-ack': 'created' });
        response.end(expected);
    });
    const cancellation = new AbortController();
    let completelyRead = false;
    // Observe actual platform Fetch IO and cancel only after its real body reaches EOF.
    const fetchAtEof: typeof fetch = async (input, init) => {
        const response = await globalThis.fetch(input, init);
        const body = response.body;
        if (!body) throw new Error('Native acknowledgement requires a body');
        const reader = body.getReader();
        const read = reader.read.bind(reader);
        vi.spyOn(reader, 'read').mockImplementation(async () => {
            const chunk = await read();
            if (chunk.done) {
                completelyRead = true;
                queueMicrotask(() => cancellation.abort());
            }
            return chunk;
        });
        Object.defineProperty(body, 'getReader', { value: () => reader });
        return response;
    };
    const runtime = createFetchPluginHttpRuntime(fetchAtEof);
    const service = owner === 'runtime' ? runtime : createPluginHttpService({ adapter: runtime });
    const response = await service.request({ url: origin + '/native/create', method: 'POST', redirect: 'error' },
        { signal: cancellation.signal });
    expect(completelyRead).toBe(true);
    expect(cancellation.signal.aborted).toBe(true);
    expect(response).toMatchObject({ status: 201, headers: { 'x-native-ack': 'created' } });
    expect(response.body).toEqual(expected);
    expect(requests).toBe(1);
});

// Only the Fetch platform boundary is substituted: browsers hide manual redirect
// responses. HTTP admission, redirect policy, transport and real HTTP stay intact.
const browserFetch: typeof fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (init?.redirect !== 'manual' || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    return Object.defineProperties(new Response(null), {
        status: { value: 0 }, type: { value: 'opaqueredirect' }, url: { value: '' },
    });
};

describe.each([['Node', globalThis.fetch], ['browser', browserFetch]] as const)('%s Fetch redirects', (_name, fetch) => {
    it.each(['request', 'requestStream'] as const)('reads the final diff and strips Authorization only on cross-origin hops (%s)', async method => {
        const hops: Array<{ path: string; headerNames: string[] }> = [];
        const receive: RequestListener = (request, response) => {
            hops.push({ path: request.url!, headerNames: Object.keys(request.headers) });
            response.end('diff --git a/a.ts b/a.ts\n-old\n+new\n');
        };
        const target = await listen(receive);
        const origin = await listen((request, response) => {
            if (request.url === '/diff') return receive(request, response);
            response.writeHead(302, { location: request.url === '/same' ? '/diff' : `${target}/diff` });
            response.end();
        });
        const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(fetch) });
        for (const path of ['/same', '/cross']) {
            const result = await http[method]({ url: `${origin}${path}`, redirect: 'follow',
                headers: { Authorization: 'synthetic-fixture-authorization' } });
            const bytes = 'body' in result ? result.body : await (async () => {
                const chunks: Uint8Array[] = [];
                for await (const chunk of result.chunks) chunks.push(chunk);
                return Buffer.concat(chunks);
            })();
            expect(result.status).toBe(200);
            expect(new TextDecoder().decode(bytes)).toContain('diff --git');
            expect(hops.at(-1)?.headerNames.includes('authorization')).toBe(path === '/same');
        }
    });
});

it.each(['request', 'requestStream'] as const)('observes the second removal within the browser cache lifetime (%s)', async method => {
    // GitHub's observed private max-age=60 lets a browser retain /pulls/54
    // across mutations at the distinct /issues/54/assignees endpoint.
    const maxAgeSeconds = 60;
    let nowMs = 0;
    let assignees: string[] = [];
    let revision = 0;
    let networkReads = 0;
    const origin = await listen((request, response) => {
        if (request.url === '/issues/54/assignees') {
            assignees = request.method === 'POST' ? ['leeroybrun'] : [];
            revision += 1;
            response.end('{}');
            return;
        }
        networkReads += 1;
        const etag = `"${revision}"`;
        response.setHeader('cache-control', `private, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`);
        response.setHeader('etag', etag);
        if (request.headers['if-none-match'] === etag) {
            response.writeHead(304);
            response.end();
            return;
        }
        response.end(JSON.stringify({ assignees }));
    });
    // Only Fetch's HTTP cache is substituted; the HTTP owner and network are real.
    const cache = new Map<string, { body: string; headers: Headers; expiresAtMs: number }>();
    const cachedBrowserFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== 'GET') return globalThis.fetch(request);
        const cached = request.cache === 'no-store' ? undefined : cache.get(request.url);
        if (cached && request.cache === 'default' && nowMs < cached.expiresAtMs) {
            return new Response(cached.body, { headers: cached.headers });
        }
        if (cached && request.cache !== 'reload') {
            request.headers.set('if-none-match', cached.headers.get('etag')!);
        }
        const response = await globalThis.fetch(request);
        const body = response.status === 304 && cached ? cached.body : await response.text();
        if (request.cache !== 'no-store') {
            cache.set(request.url, { body, headers: response.headers,
                expiresAtMs: nowMs + Number(/max-age=(\d+)/.exec(response.headers.get('cache-control')!)![1]) * 1_000 });
        }
        return new Response(body, { headers: response.headers });
    };
    const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(cachedBrowserFetch) });
    const readAssignees = async () => {
        const response = await http[method]({ url: `${origin}/pulls/54`, redirect: 'error' });
        const chunks: Uint8Array[] = [];
        if ('body' in response) chunks.push(response.body);
        else for await (const chunk of response.chunks) chunks.push(chunk);
        return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))).assignees;
    };
    for (const [index, mutation] of (['POST', 'DELETE', 'POST', 'DELETE'] as const).entries()) {
        if (index > 0) nowMs += index === 3 ? 1 : maxAgeSeconds * 1_000 + 1;
        await http.request({ url: `${origin}/issues/54/assignees`, method: mutation, redirect: 'error' });
        expect(await readAssignees(), `membership after mutation ${index + 1}`).toEqual(mutation === 'POST' ? ['leeroybrun'] : []);
    }
    expect(await readAssignees()).toEqual([]);
    expect(networkReads).toBe(5);
});

it('keeps custom secret headers and secret bodies on the inspected-hop path', async () => {
    const destinationHeaders: string[][] = [];
    const target = await listen((request, response) => {
        destinationHeaders.push(Object.keys(request.headers));
        response.end('ok');
    });
    const origin = await listen((_request, response) => {
        response.writeHead(307, { location: `${target}/target` });
        response.end();
    });
    for (const policy of [
        { readPrivateCredentialHeaderNames: () => new Set(['x-api-key']) },
        { containsRegisteredSecret: (value: string) => value.includes('synthetic-secret') },
    ]) {
        const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(globalThis.fetch), ...policy });
        await expect(http.request({ url: origin, redirect: 'follow', headers: { 'x-api-key': 'synthetic-secret' } }))
            .resolves.toMatchObject({ status: 200 });
        expect(destinationHeaders.at(-1)).not.toContain('x-api-key');
    }
    const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(globalThis.fetch),
        containsRegisteredSecret: value => value.includes('synthetic-secret') });
    await expect(http.request({ url: origin, method: 'POST', redirect: 'follow',
        body: new TextEncoder().encode('synthetic-secret') }))
        .rejects.toMatchObject({ code: 'credential_request_redirect_refused' });
    expect(destinationHeaders).toHaveLength(2);
});
