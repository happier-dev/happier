import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { FetchChangesFn } from './socketReconnectViaChanges';
import { runSocketReconnectCatchUpViaChanges } from './socketReconnectViaChanges';
import { plannedChangesAffectUsageAccounting } from './changesPlanner';
import { applyPlannedChangeActions } from './changesApplier';

const credentials: AuthCredentials = { token: 't', secret: 's' };

describe('runSocketReconnectCatchUpViaChanges', () => {
    it('classifies coalesced accounting changes against the consumed page cursor', async () => {
        for (const [afterCursor, expected] of [['7', true], ['8', false]] as const) {
            const decisions: boolean[] = [];
            await runSocketReconnectCatchUpViaChanges({
                credentials, accountId: 'a', afterCursor, changesPageLimit: 200,
                fetchChanges: async () => ({ status: 'ok', nextCursor: '14', changes: [{
                    cursor: 14, kind: 'session', entityId: 'session-a', changedAt: 1,
                    hint: { agentStateVersion: 3, usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 8 },
                }] }),
                applyPlanned: async planned => { decisions.push(plannedChangesAffectUsageAccounting(planned)); },
                snapshotRefresh: async () => ({ status: 'complete' }),
            });
            expect(decisions).toEqual([expected]);
        }
    });
    it('repairs a missing cursor before reading changes and checkpoints only the repaired base', async () => {
        const events: string[] = [];
        const fetchChanges = vi.fn<FetchChangesFn>(async ({ afterCursor }) => {
            events.push(`changes:${afterCursor}`);
            return { status: 'ok', changes: [], nextCursor: '42' };
        });
        const result = await runSocketReconnectCatchUpViaChanges({
            credentials, accountId: 'a', afterCursor: null, changesPageLimit: 200,
            fetchChanges,
            fetchCurrentCursor: async () => { events.push('capture'); return { status: 'ok', cursor: '42' }; },
            snapshotRefresh: async () => { events.push('snapshot'); return { status: 'complete' }; },
            checkpointCursor: (cursor) => { events.push(`checkpoint:${cursor}`); return true; },
            applyPlanned: async () => {},
        });
        expect(events).toEqual(['capture', 'snapshot', 'checkpoint:42', 'changes:42']);
        expect(result).toEqual({ status: 'ok', nextCursor: '42', shouldPersistCursor: false });
    });

    it('does not read history or seed a missing cursor after incomplete snapshot repair', async () => {
        const fetchChanges = vi.fn<FetchChangesFn>(async () => ({ status: 'ok', changes: [], nextCursor: '42' }));
        const checkpointCursor = vi.fn();
        const result = await runSocketReconnectCatchUpViaChanges({
            credentials, accountId: 'a', afterCursor: null, changesPageLimit: 200,
            fetchChanges,
            fetchCurrentCursor: async () => ({ status: 'ok', cursor: '42' }),
            snapshotRefresh: async () => ({ status: 'partial' }),
            checkpointCursor, applyPlanned: async () => {},
        });
        expect(result).toEqual({ status: 'fallback' });
        expect(fetchChanges).not.toHaveBeenCalled();
        expect(checkpointCursor).not.toHaveBeenCalled();
    });

    it('returns fallback when credentials missing', async () => {
        const res = await runSocketReconnectCatchUpViaChanges({
            credentials: null,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            fetchChanges: (async () => ({ status: 'error' })) as FetchChangesFn,
            applyPlanned: async () => {},
            snapshotRefresh: async () => ({ status: 'complete' }),
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
            fetchChanges,
            applyPlanned: async () => {},
            snapshotRefresh: async () => ({ status: 'complete' }),
        });

        expect(res).toEqual({ status: 'fallback' });
        expect(fetchChanges).toHaveBeenCalledTimes(1);
    });

    it('triggers snapshot repair on cursor-gone and returns the repaired cursor', async () => {
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const fetchChanges = vi.fn<FetchChangesFn>()
            .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '999' })
            .mockResolvedValueOnce({ status: 'ok' as const, changes: [], nextCursor: '999' });

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '10',
            changesPageLimit: 200,
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
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
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

    it('drains changed rows beyond the old page budget without a full inventory snapshot', async () => {
        const applyPlanned = vi.fn(async () => {});
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
        const changes = Array.from({ length: 401 }, (_, i) => ({
            cursor: i + 1, kind: 'session' as const, entityId: `s${i}`, changedAt: 1,
        }));
        const fetchChanges = vi.fn<FetchChangesFn>(async ({ afterCursor }) => ({
            status: 'ok' as const,
            changes: changes.slice(Number(afterCursor), Number(afterCursor) + 200),
            nextCursor: String(Math.min(Number(afterCursor) + 200, changes.length)),
        }));

        const res = await runSocketReconnectCatchUpViaChanges({
            credentials,
            accountId: 'a',
            afterCursor: '0',
            changesPageLimit: 200,
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['0', '200', '400']);
        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(applyPlanned).toHaveBeenCalledTimes(3);
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '401',
            shouldPersistCursor: true,
        });
    });

    it('paginates full pages and materializes the short tail without a snapshot', async () => {
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

    it('stops a blocked-page scan when its safe checkpoint is refused', async () => {
        const requestedCursors: Array<string | null> = [];
        const result = await runSocketReconnectCatchUpViaChanges({
            credentials, accountId: 'a', afterCursor: '0', changesPageLimit: 2,
            fetchChanges: async ({ afterCursor }) => {
                requestedCursors.push(afterCursor);
                return { status: 'ok', nextCursor: '2', changes: [
                    { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 1 } },
                    { cursor: 2, kind: 'future-kind', entityId: 'blocked', changedAt: 2 },
                ] };
            },
            checkpointCursor: () => false,
            applyPlanned: planned => applyPlannedChangeActions({
                planned, credentials, isSessionMessagesLoaded: () => false, invalidate: {},
                invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
            }),
            snapshotRefresh: async () => { throw new Error('A refused checkpoint must end this scan'); },
        });

        expect(requestedCursors).toEqual(['0']);
        expect(result).toEqual({ status: 'ok', nextCursor: '1', shouldPersistCursor: true });
    });

    it.each(['short', 'empty'] as const)('retains the first safe checkpoint across later partial and complete pages with a %s tail', async tail => {
        const requestedCursors: Array<string | null> = [];
        const checkpoints: string[] = [];
        const result = await runSocketReconnectCatchUpViaChanges({
            credentials, accountId: 'a', afterCursor: '0', changesPageLimit: 2,
            fetchChanges: async ({ afterCursor }) => {
                requestedCursors.push(afterCursor);
                const firstCursor = Number(afterCursor) + 1;
                const complete = { cursor: firstCursor, kind: 'account', entityId: 'self', changedAt: firstCursor,
                    hint: { settingsVersion: 1 } };
                if (afterCursor === '6') return { status: 'ok', nextCursor: '6', changes: [] };
                if (afterCursor === '4' && tail === 'short') return { status: 'ok', nextCursor: '5', changes: [complete] };
                return { status: 'ok', nextCursor: String(firstCursor + 1), changes: [complete,
                    { cursor: firstCursor + 1, kind: afterCursor === '4' ? 'account' : 'future-kind',
                        entityId: afterCursor === '4' ? 'self' : 'next', changedAt: firstCursor + 1,
                        ...(afterCursor === '4' ? { hint: { settingsVersion: 1 } } : {}) },
                ] };
            },
            checkpointCursor: cursor => { checkpoints.push(cursor); return true; },
            applyPlanned: planned => applyPlannedChangeActions({
                planned, credentials, isSessionMessagesLoaded: () => false, invalidate: {},
                invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
            }),
            snapshotRefresh: async () => { throw new Error('A short tail needs no snapshot repair'); },
        });

        expect(requestedCursors).toEqual(tail === 'short' ? ['0', '2', '4'] : ['0', '2', '4', '6']);
        expect(checkpoints).toEqual(['1']);
        expect(result).toEqual({ status: 'ok', nextCursor: '1', shouldPersistCursor: false });
    });

    it('uses a valid cursor without a full snapshot and materializes the actual changed Session', async () => {
        const applyPlanned = vi.fn(async (_planned: unknown) => {});
        const snapshotRefresh = vi.fn(async () => ({ status: 'complete' as const }));
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
            fetchChanges,
            applyPlanned,
            snapshotRefresh,
        });

        expect(snapshotRefresh).not.toHaveBeenCalled();
        expect(fetchChanges.mock.calls.map(([call]) => call.afterCursor)).toEqual(['10']);
        expect(applyPlanned).toHaveBeenCalledTimes(1);
        expect(applyPlanned.mock.calls[0]?.[0]).toMatchObject({ changes: [{ cursor: 11, kind: 'session', entityId: 's1' }] });
        expect(res).toEqual({
            status: 'ok',
            nextCursor: '11',
            shouldPersistCursor: true,
        });
    });
});
