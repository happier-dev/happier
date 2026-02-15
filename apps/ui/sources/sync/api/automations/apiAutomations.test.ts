import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { runAutomationNow } from './apiAutomations';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

describe('apiAutomations', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not send JSON Content-Type for run-now POST requests without a body', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                run: {
                    id: 'run-1',
                    automationId: 'auto-1',
                    state: 'queued',
                    scheduledAt: Date.now(),
                    dueAt: Date.now(),
                    claimedAt: null,
                    startedAt: null,
                    finishedAt: null,
                    claimedByMachineId: null,
                    leaseExpiresAt: null,
                    attempt: 0,
                    summaryCiphertext: null,
                    errorCode: null,
                    errorMessage: null,
                    producedSessionId: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            }),
        }));

        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await runAutomationNow(credentials, 'auto-1');

        const request = fetchSpy.mock.calls[0]?.[1];
        const headers = new Headers(request?.headers);

        expect(headers.get('Authorization')).toBe('Bearer token-1');
        expect(headers.get('Content-Type')).toBeNull();
    });
});
