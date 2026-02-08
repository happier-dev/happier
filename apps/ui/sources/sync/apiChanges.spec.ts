import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchChanges } from './apiChanges';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com',
}));

const credentials: AuthCredentials = { token: 't', secret: 's' };

function okJson(payload: unknown) {
    return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(payload),
    };
}

function errorJson(status: number, payload: unknown) {
    return {
        ok: false,
        status,
        json: vi.fn().mockResolvedValue(payload),
    };
}

describe('apiChanges', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn() as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns ok + nextCursor on success', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
            okJson({
                changes: [{ cursor: 2, kind: 'session', entityId: 's1', changedAt: 1, hint: null }],
                nextCursor: 2,
            }),
        );

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 50 });

        expect(res).toEqual({
            status: 'ok',
            changes: [{ cursor: 2, kind: 'session', entityId: 's1', changedAt: 1, hint: null }],
            nextCursor: '2',
        });
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.test.com/v2/changes?after=1&limit=50',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer t' }),
            }),
        );
    });

    it('returns cursor-gone for 410 responses', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
            errorJson(410, { error: 'cursor-gone', currentCursor: 9 }),
        );

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '9' });
    });

    it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(errorJson(404, { error: 'not-found' }));

        const res = await fetchChanges({ credentials, afterCursor: '0', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('returns cursor-gone with fallback cursor when 410 body is invalid', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            ok: false,
            status: 410,
            json: vi.fn().mockRejectedValue(new Error('invalid json')),
        });

        const res = await fetchChanges({ credentials, afterCursor: '5', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '0' });
    });

    it('returns error when fetch throws (network failure)', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('normalizes invalid afterCursor and clamps limit', async () => {
        (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
            okJson({
                changes: [],
                nextCursor: 0,
            }),
        );

        await fetchChanges({ credentials, afterCursor: '-100', limit: 10_000 });
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.test.com/v2/changes?after=0&limit=500',
            expect.any(Object),
        );
    });
});
