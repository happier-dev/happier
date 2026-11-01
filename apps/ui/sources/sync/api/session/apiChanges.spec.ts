import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withConnectedServiceReaderSupport } from '@happier-dev/protocol';
import { createServerFetchWithReachabilityProbe } from '@/dev/testkit/mocks/serverFetch';

import { fetchChanges, fetchCurrentChangesCursor } from './apiChanges';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.test.com',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 't', secret: 's' };
const fetchMock = vi.fn();

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
        fetchMock.mockReset();
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(fetchMock)));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('returns ok + nextCursor on success', async () => {
        fetchMock.mockResolvedValue(
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
        const expectedUrl = withConnectedServiceReaderSupport('https://api.test.com/v2/changes?after=1&limit=50');
        expect(global.fetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
        const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const call = calls.find(([input]) => String(input) === expectedUrl);
        const requestInit = call?.[1] as RequestInit | undefined;
        expect(requestInit).toBeDefined();
        expect(requestInit?.headers).toBeInstanceOf(Headers);
        expect((requestInit!.headers as Headers).get('Authorization')).toBe('Bearer t');
    });

    it('returns cursor-gone for 410 responses', async () => {
        fetchMock.mockResolvedValue(
            errorJson(410, { error: 'cursor-gone', currentCursor: 9 }),
        );

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '9' });
    });

    it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
        fetchMock.mockResolvedValue(errorJson(404, { error: 'not-found' }));

        const res = await fetchChanges({ credentials, afterCursor: '0', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('returns cursor-gone with fallback cursor when 410 body is invalid', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 410,
            json: vi.fn().mockRejectedValue(new Error('invalid json')),
        });

        const res = await fetchChanges({ credentials, afterCursor: '5', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '0' });
    });

    it('returns error when fetch throws (network failure)', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('normalizes invalid afterCursor and clamps limit', async () => {
        fetchMock.mockResolvedValue(
            okJson({
                changes: [],
                nextCursor: 0,
            }),
        );

        await fetchChanges({ credentials, afterCursor: '-100', limit: 10_000 });
        expect(global.fetch).toHaveBeenCalledWith(
            withConnectedServiceReaderSupport('https://api.test.com/v2/changes?after=0&limit=500'),
            expect.any(Object),
        );
    });

    it('returns the current cursor from /v2/cursor', async () => {
        fetchMock.mockResolvedValue(okJson({ cursor: 42, changesFloor: 7 }));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'ok', cursor: '42' });
        const expectedUrl = withConnectedServiceReaderSupport('https://api.test.com/v2/cursor');
        expect(global.fetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
        const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const call = calls.find(([input]) => String(input) === expectedUrl);
        const requestInit = call?.[1] as RequestInit | undefined;
        expect(requestInit).toBeDefined();
        expect(requestInit?.headers).toBeInstanceOf(Headers);
        expect((requestInit!.headers as Headers).get('Authorization')).toBe('Bearer t');
    });

    it('returns error when /v2/cursor payload is invalid', async () => {
        fetchMock.mockResolvedValue(okJson({ cursor: -1, changesFloor: 0 }));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'error' });
    });

    it('returns error when /v2/cursor fetch throws', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'error' });
    });
});
