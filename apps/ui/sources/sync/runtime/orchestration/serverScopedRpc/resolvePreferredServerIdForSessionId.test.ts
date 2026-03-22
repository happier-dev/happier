import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveServerIdForSessionIdFromLocalCacheMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('./resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) =>
        resolveServerIdForSessionIdFromLocalCacheMock(sessionId),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));

describe('resolvePreferredServerIdForSessionId', () => {
    beforeEach(() => {
        resolveServerIdForSessionIdFromLocalCacheMock.mockReset();
        getActiveServerSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReturnValue({ serverId: 'active-server' });
    });

    it('prefers the locally resolved owning server for a known session', async () => {
        resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('owner-server');

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('owner-server');
    });

    it('falls back to the active server when the owning server is unknown', async () => {
        resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue(null);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('active-server');
    });
});
