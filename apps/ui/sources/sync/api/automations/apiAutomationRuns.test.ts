import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { listAutomationRuns } from './apiAutomationRuns';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

describe('apiAutomationRuns', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('requests run history with clamped limit and optional cursor', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                runs: [],
                nextCursor: null,
            }),
        }));

        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await listAutomationRuns({
            credentials,
            automationId: 'auto-1',
            limit: 999,
            cursor: 'next-1',
        });

        const requestUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
        const request = fetchSpy.mock.calls[0]?.[1];
        const headers = new Headers(request?.headers);

        expect(requestUrl).toContain('/v2/automations/auto-1/runs?limit=100&cursor=next-1');
        expect(headers.get('Authorization')).toBe('Bearer token-1');
    });
});
