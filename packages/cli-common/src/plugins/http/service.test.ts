import { describe, expect, it } from 'vitest';
import { createStablePluginHttpHost } from './service.js';
import { createProviderRedactionLease } from './redaction.js';

describe('portable HTTP finite custody', () => {
    it.each(['request', 'requestStream'] as const)('applies a matching request interceptor without a Node operation context (%s)', async method => {
        const contribution = { id: 'headers', origins: ['https://api.example.test'] };
        const host = createStablePluginHttpHost({ adapter: {
            async request(request) { return { status: 200, headers: request.headers ?? {}, finalUrl: request.url, body: new Uint8Array() }; },
            async requestStream(request) { return { status: 200, headers: request.headers ?? {}, finalUrl: request.url,
                chunks: (async function* () {})(), async dispose() {} }; },
            async openWebSocket() { throw new Error('Not used'); },
        }, interceptorRegistry: {
            declarations: [{ pluginId: 'example.interceptor', contribution }],
            async activateContributionsOnDemand() {},
            readBindings: () => [{ pluginId: 'example.interceptor', contribution,
                async invoke(request) { return { decision: 'continue', request: { ...request, headers: { ...request.headers, 'x-intercepted': 'yes' } } }; } }],
        } });
        const http = host.bind({ plugin: { id: 'example.portable' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true }, {});
        const responses = await Promise.all(['/body', '/other'].map(path =>
            http[method]({ url: `https://api.example.test${path}`, redirect: 'error' })));
        expect(responses).toMatchObject([
            { headers: { 'x-intercepted': 'yes' } },
            { headers: { 'x-intercepted': 'yes' } },
        ]);
        if (method === 'requestStream') {
            await Promise.all(responses.map(response => 'dispose' in response ? response.dispose() : undefined));
        }
    });

    it.each(['request', 'requestStream'] as const)('preserves interceptor denial without a Node operation context (%s)', async method => {
        const contribution = { id: 'deny', origins: ['https://api.example.test'] };
        const host = createStablePluginHttpHost({ adapter: {
            async request() { throw new Error('Denied request reached transport'); },
            async requestStream() { throw new Error('Denied request reached transport'); },
            async openWebSocket() { throw new Error('Not used'); },
        }, interceptorRegistry: {
            declarations: [{ pluginId: 'example.interceptor', contribution }],
            async activateContributionsOnDemand() {},
            readBindings: () => [{ pluginId: 'example.interceptor', contribution,
                async invoke() { return { decision: 'deny', code: 'blocked' }; } }],
        } });
        const http = host.bind({ plugin: { id: 'example.portable' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true }, {});
        await expect(http[method]({ url: 'https://api.example.test/body', redirect: 'error' }))
            .rejects.toMatchObject({ code: 'plugin_fetch_interceptor_denied' });
    });

    it('preserves a failed transport outcome without a final purpose authority check', async () => {
        const failure = new Error('transport failed');
        const lease = createProviderRedactionLease({ values: ['selected-token'] });
        const host = createStablePluginHttpHost({ adapter: {
            async request() { throw failure; }, async requestStream() { throw failure; },
            async openWebSocket() { throw new Error('Not used'); },
        }, purposeHost: {
            request: input => input.execute(),
            requestStream: input => input.execute({ headers: { authorization: 'Bearer selected-token' },
                secretHeaderNames: ['authorization'], redact: lease.redact, createStreamingSanitizer: lease.createStreamingSanitizer }),
        } });
        try {
            const http = host.bind({ plugin: { id: 'example.portable' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true }, {});
            await expect(http.requestStream({ url: 'https://api.example.test/body', redirect: 'error' })).rejects.toBe(failure);
        } finally { lease.close(); }
    });
});
