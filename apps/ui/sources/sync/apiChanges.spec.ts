import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchChanges } from './apiChanges';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com',
}));

describe('apiChanges', () => {
    const credentials = { token: 't', secret: 's' } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns ok + nextCursor on success', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                changes: [{ cursor: 2, kind: 'session', entityId: 's1', changedAt: 1, hint: null }],
                nextCursor: 2,
            }),
        });

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
        (global.fetch as any).mockResolvedValue({
            ok: false,
            status: 410,
            json: vi.fn().mockResolvedValue({ error: 'cursor-gone', currentCursor: 9 }),
        });

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '9' });
    });

    it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false,
            status: 404,
            json: vi.fn().mockResolvedValue({ error: 'not-found' }),
        });

        const res = await fetchChanges({ credentials, afterCursor: '0', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });
});
