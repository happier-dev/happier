import { describe, expect, it, vi, beforeEach } from 'vitest';

const serverFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

import { fetchAccountSettingsHistory } from './apiAccountSettingsHistory';

function jsonResponse(payload: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => payload,
    };
}

describe('fetchAccountSettingsHistory', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
    });

    it('lists content-free history snapshots through the V2 history route', async () => {
        serverFetchMock.mockResolvedValue(jsonResponse({
            snapshots: [
                { version: 3, createdAt: '2026-08-29T10:00:00.000Z', contentKind: 'plain', byteLength: 128 },
                { version: 2, createdAt: '2026-08-28T10:00:00.000Z', contentKind: 'encrypted', byteLength: 256 },
            ],
        }));
        await expect(fetchAccountSettingsHistory({ token: 'token-1' } as never)).resolves.toEqual({
            status: 'ready',
            snapshots: [
                { version: 3, createdAt: '2026-08-29T10:00:00.000Z', contentKind: 'plain', byteLength: 128 },
                { version: 2, createdAt: '2026-08-28T10:00:00.000Z', contentKind: 'encrypted', byteLength: 256 },
            ],
        });
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/v2/account/settings/history',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }),
            expect.objectContaining({ includeAuth: false }),
        );
    });

    it('reports unavailable transport and malformed listings without throwing', async () => {
        serverFetchMock.mockResolvedValue(jsonResponse({}, false, 500));
        await expect(fetchAccountSettingsHistory({ token: 'token-1' } as never)).resolves.toEqual({
            status: 'unavailable',
        });
        serverFetchMock.mockResolvedValue(jsonResponse({ snapshots: [{ version: 'x' }] }));
        await expect(fetchAccountSettingsHistory({ token: 'token-1' } as never)).resolves.toEqual({
            status: 'unavailable',
        });
        serverFetchMock.mockRejectedValue(new Error('offline'));
        await expect(fetchAccountSettingsHistory({ token: 'token-1' } as never)).resolves.toEqual({
            status: 'unavailable',
        });
    });
});
