import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createFetchPluginHttpRuntime } from './fetchTransport.js';
import { createPluginHttpService } from './service.js';

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
