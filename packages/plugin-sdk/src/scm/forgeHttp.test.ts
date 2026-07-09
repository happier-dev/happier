import { describe, expect, it } from 'vitest';

import { requestScmForgeJson, type ScmForgeHttpErrorContext } from './forgeHttp.js';

function jsonResponse(body: unknown, init?: Readonly<{ status?: number; statusText?: string }>) {
    const status = init?.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: init?.statusText ?? 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

describe('requestScmForgeJson', () => {
    it('redacts sensitive request headers in error context while sending real credentials', async () => {
        let fetchAuthorization: string | null = null;
        let mappedContext: ScmForgeHttpErrorContext | null = null;

        await expect(requestScmForgeJson({
            url: 'https://api.github.com/repos/happier-dev/private',
            init: {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer secret-token',
                    'X-Api-Key': 'secret-api-key',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: 'private' }),
            },
            fetcher: async (_url, init) => {
                const headers = init?.headers as Readonly<Record<string, string>>;
                fetchAuthorization = headers.Authorization ?? null;
                return jsonResponse({ message: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
            },
            mapError: (context) => {
                mappedContext = context;
                return new Error(`mapped ${context.status}`);
            },
        })).rejects.toThrow('mapped 403');

        expect(fetchAuthorization).toBe('Bearer secret-token');
        expect(mappedContext).toMatchObject({
            url: 'https://api.github.com/repos/happier-dev/private',
            method: 'POST',
            status: 403,
            statusText: 'Forbidden',
            body: { message: 'forbidden' },
            request: {
                headers: {
                    Authorization: '[redacted]',
                    'X-Api-Key': '[redacted]',
                    'Content-Type': 'application/json',
                },
            },
        });
        expect(JSON.stringify(mappedContext)).not.toContain('secret-token');
        expect(JSON.stringify(mappedContext)).not.toContain('secret-api-key');
    });

    it('preserves non-JSON error response bodies from real fetch responses', async () => {
        let mappedContext: ScmForgeHttpErrorContext | null = null;

        await expect(requestScmForgeJson({
            url: 'https://api.github.com/repos/happier-dev/private',
            fetcher: async () => new Response('service unavailable', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'text/plain' },
            }),
            mapError: (context) => {
                mappedContext = context;
                return new Error(`mapped ${context.status}`);
            },
        })).rejects.toThrow('mapped 503');

        expect(mappedContext).toMatchObject({
            status: 503,
            statusText: 'Service Unavailable',
            body: 'service unavailable',
        });
    });
});
