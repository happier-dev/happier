import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalFetchRuntime } from './globalFetchRuntime';

describe('createGlobalFetchRuntime', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('passes manual redirect mode to the system boundary and exposes the 3xx response', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { location: 'https://next.example.test/result' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await createGlobalFetchRuntime()({
            url: 'https://api.example.test/start',
            metadata: { redirect: 'manual' },
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/start',
            expect.objectContaining({ redirect: 'manual' }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('https://next.example.test/result');
    });
});
