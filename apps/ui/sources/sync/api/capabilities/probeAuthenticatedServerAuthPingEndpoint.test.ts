import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { probeAuthenticatedServerAuthPingEndpoint } from './probeAuthenticatedServerAuthPingEndpoint';

afterEach(() => {
    resetRuntimeFetch();
});

describe('probeAuthenticatedServerAuthPingEndpoint', () => {
    it('reports ready for the documented 200 JSON answer', async () => {
        setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result.status).toBe('ready');
    });

    it('does not report ready when the host does not serve the route (404)', async () => {
        setRuntimeFetch(vi.fn(async () => new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result.status).toBe('server_unreachable');
    });

    it('does not report ready when a captive portal answers 200 with an HTML document', async () => {
        setRuntimeFetch(vi.fn(async () => new Response('<html><body>Sign in to Wi-Fi</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result.status).toBe('server_unreachable');
    });

    it('still classifies 401/403 as an auth failure rather than an outage', async () => {
        setRuntimeFetch(vi.fn(async () => new Response('nope', { status: 403 })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result).toMatchObject({ status: 'auth_failed', statusCode: 403 });
    });

    it('still classifies a planned restart as retry_later with its reason', async () => {
        setRuntimeFetch(vi.fn(async () => new Response('Server reload in progress', {
            status: 503,
            headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' },
        })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result).toMatchObject({ status: 'retry_later', reason: 'server_restarting', retryAfterMs: 2000 });
    });

    it('accepts a 200 whose content type an intermediary stripped', async () => {
        setRuntimeFetch(vi.fn(async () => new Response(null, { status: 200 })));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token',
        });

        expect(result.status).toBe('ready');
    });
});
