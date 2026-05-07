import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
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

    it('triggers snapshot repair on cursor-gone and returns the repaired cursor', async () => {
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '999' })
            .mockResolvedValueOnce({ status: 'ok' as const, changes: [], nextCursor: '999' });

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
        expect(fetchChanges).toHaveBeenCalledTimes(2);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '999',
            shouldPersistCursor: true,
        });
    });

    it('uses a snapshot-base cursor captured before cursor-gone snapshot instead of the 410 cursor', async () => {
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchCurrentCursor = vi.fn(async () => ({ status: 'ok' as const, cursor: '1500' }));
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '999' })
            .mockResolvedValueOnce({ status: 'ok' as const, changes: [], nextCursor: '1500' });

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            fetchCurrentCursor,
            applyPlanned: async () => {},
            snapshotRefresh,
        });

        expect(fetchCurrentCursor).toHaveBeenCalledTimes(1);
        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['10', '1500']);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '1500',
            shouldPersistCursor: true,
        });
    });

    it('does not advance when snapshot-base cursor capture fails', async () => {
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchCurrentCursor = vi.fn(async () => ({ status: 'error' as const }));
        const onSnapshotBaseCursorFetchFailed = vi.fn();
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'cursor-gone' as const, currentCursor: '999' }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            fetchCurrentCursor,
            onSnapshotBaseCursorFetchFailed,
            applyPlanned: async () => {},
            snapshotRefresh,
        });

        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(onSnapshotBaseCursorFetchFailed).toHaveBeenCalledWith({
            trigger: 'cursor-gone',
            fallbackCursor: '999',
            error: 'status:error',
        });
        expect(res).toEqual({ status: 'fallback' });
    });

    it('returns fallback and reports telemetry when snapshot-base cursor capture throws', async () => {
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchCurrentCursor = vi.fn(async () => {
            throw new Error('network down');
        });
        const onSnapshotBaseCursorFetchFailed = vi.fn();
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'cursor-gone' as const, currentCursor: '999' }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            fetchCurrentCursor,
            onSnapshotBaseCursorFetchFailed,
            applyPlanned: async () => {},
            snapshotRefresh,
        });

        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(onSnapshotBaseCursorFetchFailed).toHaveBeenCalledWith({
            trigger: 'cursor-gone',
            fallbackCursor: '999',
            error: 'network down',
        });
        expect(res).toEqual({ status: 'fallback' });
    });

    it('persists the snapshot-base checkpoint and then drains incremental changes after it', async () => {
        const order: string[] = [];
        const snapshotRefresh = vi.fn(async () => {
            order.push('snapshot');
            return { status: 'complete' as const };
        });
        const checkpointCursor = vi.fn(async (cursor: string) => {
            order.push(`checkpoint:${cursor}`);
            return true;
        });
        const applyPlanned = vi.fn(async () => {
            order.push('apply');
            return { status: 'complete' as const, safeAdvanceCursor: '1501' };
        });
        const fetchCurrentCursor = vi.fn(async () => ({ status: 'ok' as const, cursor: '1500' }));
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '999' })
            .mockResolvedValueOnce({
                status: 'ok' as const,
                changes: [{ cursor: 1501, kind: 'session' as const, entityId: 's1', changedAt: 1 }],
                nextCursor: '1501',
            });

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            fetchCurrentCursor,
            checkpointCursor,
            applyPlanned,
            snapshotRefresh,
        });

        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['10', '1500']);
        expect(order).toEqual(['snapshot', 'checkpoint:1500', 'apply', 'checkpoint:1501']);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '1501',
            shouldPersistCursor: false,
        });
    });

    it('returns fallback when the snapshot-base checkpoint cannot be persisted', async () => {
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const checkpointCursor = vi.fn(async () => false);
        const fetchCurrentCursor = vi.fn(async () => ({ status: 'ok' as const, cursor: '1500' }));
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'cursor-gone' as const, currentCursor: '999' }));
        const applyPlanned = vi.fn(async () => {});

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            fetchCurrentCursor,
            checkpointCursor,
            applyPlanned,
            snapshotRefresh,
        });

        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(checkpointCursor).toHaveBeenCalledWith('1500', {
            reason: 'snapshot-base',
            changes: [],
        });
        expect(applyPlanned).not.toHaveBeenCalled();
        expect(res).toEqual({ status: 'fallback' });
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
        });
    });

    it('reports a cursor contract anomaly when a changes response repeats the requested after cursor', async () => {
        const onCursorContractAnomaly = vi.fn();
        const applyPlanned = vi.fn(async () => ({ status: 'complete' as const, safeAdvanceCursor: '11' }));
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: [
                { cursor: 10, kind: 'session' as const, entityId: 's0', changedAt: 1 },
                { cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 },
            ],
            nextCursor: '11',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            onCursorContractAnomaly,
            applyPlanned,
            snapshotRefresh: async () => ({ status: 'complete' as const }),
        });

        expect(onCursorContractAnomaly).toHaveBeenCalledWith({
            reason: 'returned-after-cursor',
            afterCursor: '10',
            offendingCursor: '10',
            nextCursor: '11',
            changes: [
                { cursor: 10, kind: 'session', entityId: 's0', changedAt: 1 },
                { cursor: 11, kind: 'session', entityId: 's1', changedAt: 1 },
            ],
        });
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
        });
    });

    it('reports a cursor contract anomaly when a changes response returns a cursor before the requested after cursor', async () => {
        const onCursorContractAnomaly = vi.fn();
        const applyPlanned = vi.fn(async () => ({ status: 'complete' as const, safeAdvanceCursor: '11' }));
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: [
                { cursor: 9, kind: 'session' as const, entityId: 's0', changedAt: 1 },
                { cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 },
            ],
            nextCursor: '11',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            onCursorContractAnomaly,
            applyPlanned,
            snapshotRefresh: async () => ({ status: 'complete' as const }),
        });

        expect(onCursorContractAnomaly).toHaveBeenCalledWith({
            reason: 'returned-before-after-cursor',
            afterCursor: '10',
            offendingCursor: '9',
            nextCursor: '11',
            changes: [
                { cursor: 9, kind: 'session', entityId: 's0', changedAt: 1 },
                { cursor: 11, kind: 'session', entityId: 's1', changedAt: 1 },
            ],
        });
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
        });
    });

    it('triggers snapshot refresh after the full-page catch-up budget is exhausted', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
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
            maxChangesPagesPerResume: 2,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(fetchChanges).toHaveBeenCalledTimes(2);
        expect(snapshotRefresh).toHaveBeenCalledTimes(1);
        expect(applyPlanned).toHaveBeenCalledTimes(2);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '200',
            shouldPersistCursor: true,
        });
    });

    it('paginates full pages before snapshot escalation', async () => {
        const applyPlanned = vi.fn(async () => ({ status: 'complete' as const, safeAdvanceCursor: null }));
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({
                status: 'ok' as const,
                changes: [
                    { cursor: 1, kind: 'session' as const, entityId: 's1', changedAt: 1 },
                    { cursor: 2, kind: 'session' as const, entityId: 's2', changedAt: 1 },
                ],
                nextCursor: '2',
            })
            .mockResolvedValueOnce({
                status: 'ok' as const,
                changes: [{ cursor: 3, kind: 'session' as const, entityId: 's3', changedAt: 1 }],
                nextCursor: '3',
            });

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 2,
            forceSnapshotRefresh: false,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(fetchChanges).toHaveBeenCalledTimes(2);
        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['0', '2']);
        expect(applyPlanned).toHaveBeenCalledTimes(2);
        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '3',
            shouldPersistCursor: true,
        });
    });

    it('checkpoints each fully materialized page before fetching the next page', async () => {
        const order: string[] = [];
        const checkpointCursor = vi.fn(async (cursor: string) => {
            order.push(`checkpoint:${cursor}`);
            return true;
        });
        const applyPlanned = vi.fn(async () => ({ status: 'complete' as const }));
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockImplementationOnce(async () => {
                order.push('fetch:0');
                return {
                    status: 'ok' as const,
                    changes: [
                        { cursor: 1, kind: 'session' as const, entityId: 's1', changedAt: 1 },
                        { cursor: 2, kind: 'session' as const, entityId: 's2', changedAt: 1 },
                    ],
                    nextCursor: '2',
                };
            })
            .mockImplementationOnce(async () => {
                order.push('fetch:2');
                return {
                    status: 'ok' as const,
                    changes: [{ cursor: 3, kind: 'session' as const, entityId: 's3', changedAt: 1 }],
                    nextCursor: '3',
                };
            });

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 2,
            forceSnapshotRefresh: false,
            fetchChanges,
            checkpointCursor,
            applyPlanned,
            snapshotRefresh,
        });

        expect(order).toEqual(['fetch:0', 'checkpoint:2', 'fetch:2', 'checkpoint:3']);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '3',
            shouldPersistCursor: false,
        });
    });

    it('advances only to applyPlanned safeAdvanceCursor when a page partially applies', async () => {
        const applyPlanned = vi.fn(async () => ({ status: 'partial' as const, safeAdvanceCursor: '2' }));
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes: [
                { cursor: 1, kind: 'session' as const, entityId: 's1', changedAt: 1 },
                { cursor: 2, kind: 'session' as const, entityId: 's2', changedAt: 1 },
                { cursor: 3, kind: 'session' as const, entityId: 's3', changedAt: 1 },
            ],
            nextCursor: '3',
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

        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '2',
            shouldPersistCursor: true,
        });
    });

    it('reports blocked cursor details for partial apply results', async () => {
        const onCursorBlocked = vi.fn();
        const checkpointCursor = vi.fn(async () => true);
        const applyPlanned = vi.fn(async () => ({
            status: 'partial' as const,
            safeAdvanceCursor: '1',
            blockedCursor: '2',
            blockedReason: 'unsupported-kind',
        }));
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const changes = [
            { cursor: 1, kind: 'session' as const, entityId: 's1', changedAt: 1 },
            { cursor: 2, kind: 'future-kind', entityId: 'x1', changedAt: 1 },
        ];
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes,
            nextCursor: '2',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            checkpointCursor,
            onCursorBlocked,
            applyPlanned,
            snapshotRefresh,
        });

        expect(onCursorBlocked).toHaveBeenCalledWith({
            blockedCursor: '2',
            blockedReason: 'unsupported-kind',
            safeAdvanceCursor: '1',
            changes,
        });
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '1',
            shouldPersistCursor: false,
        });
    });

    it('reports unsupported kinds as blocked when the safe cursor stays behind them', async () => {
        const onCursorBlocked = vi.fn();
        const onUnsupportedChanges = vi.fn();
        const checkpointCursor = vi.fn(async () => true);
        const applyPlanned = vi.fn(async () => ({
            status: 'partial' as const,
            safeAdvanceCursor: '1',
            blockedCursor: '2',
            blockedReason: 'unsupported-kind',
        }));
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const changes = [
            { cursor: 1, kind: 'session' as const, entityId: 's1', changedAt: 1 },
            { cursor: 2, kind: 'future-kind', entityId: 'x1', changedAt: 1 },
        ];
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({
            status: 'ok' as const,
            changes,
            nextCursor: '2',
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            forceSnapshotRefresh: false,
            fetchChanges,
            checkpointCursor,
            onCursorBlocked,
            onUnsupportedChanges,
            applyPlanned,
            snapshotRefresh,
        } as Parameters<typeof runSocketReconnectCatchUpViaChanges>[0] & {
            onUnsupportedChanges: typeof onUnsupportedChanges;
        });

        expect(onCursorBlocked).toHaveBeenCalledWith({
            blockedCursor: '2',
            blockedReason: 'unsupported-kind',
            safeAdvanceCursor: '1',
            changes,
        });
        expect(onUnsupportedChanges).toHaveBeenCalledWith([
            { cursor: '2', kind: 'future-kind', entityId: 'x1' },
        ]);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '1',
            shouldPersistCursor: false,
        });
    });

    it('can force snapshot refresh even when under the page limit', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => {});
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({
                status: 'ok' as const,
                changes: [{ cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 }],
                nextCursor: '11',
            })
            .mockResolvedValueOnce({
                status: 'ok' as const,
                changes: [],
                nextCursor: '11',
            });

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
        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['10', '11']);
        expect(applyPlanned).not.toHaveBeenCalled();
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
        });
    });
});
