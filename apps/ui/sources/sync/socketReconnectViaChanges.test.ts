import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { FetchChangesFn } from './socketReconnectViaChanges';
import { runSocketReconnectCatchUpViaChanges } from './socketReconnectViaChanges';

const credentials: AuthCredentials = { token: 't', secret: 's' };

describe('runSocketReconnectCatchUpViaChanges', () => {
    it('returns fallback when credentials missing', async () => {
        const res = await runSocketReconnectCatchUpViaChanges({
            credentials: null,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges: (async () => ({ status: 'error' })) as FetchChangesFn,
            applyPlanned: async () => {},
            snapshotRefresh: async () => {},
        });

        expect(res.status).toBe('fallback');
    });

    it('returns fallback when fetchChanges errors', async () => {
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'error' as const }));
        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned: async () => {},
            snapshotRefresh: async () => {},
        });

        expect(res).toEqual({ status: 'fallback' });
        expect(fetchChanges).toHaveBeenCalledTimes(1);
    });

    it('triggers snapshot refresh on cursor-gone and flushes cursor immediately', async () => {
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'cursor-gone' as const, currentCursor: '999' }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned: async () => {},
            snapshotRefresh,
        });

        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '999',
            shouldPersistCursor: true,
            flushCursorNow: true,
        });
    });

    it('applies planned changes when within page limit', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: [{ cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 }],
            nextCursor: '11',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(applyPlanned).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
            flushCursorNow: false,
        });
    });

    it('triggers snapshot refresh when changes hit the page limit', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: Array.from({ length: 200 }, (_, i) => ({
                cursor: i + 1,
                kind: 'session' as const,
                entityId: `s${i}`,
                changedAt: 1,
            })),
            nextCursor: '200',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(applyPlanned).not.toHaveBeenCalled();
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '200',
            shouldPersistCursor: true,
            flushCursorNow: true,
        });
    });

    it('can force snapshot refresh even when under the page limit', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: [{ cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 }],
            nextCursor: '11',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: true,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(applyPlanned).not.toHaveBeenCalled();
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
            flushCursorNow: true,
        });
    });
});
