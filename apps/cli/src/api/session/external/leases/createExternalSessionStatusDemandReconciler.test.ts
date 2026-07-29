import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExternalSessionStatusDemandReconciler,
    type ExternalSessionStatusDemandChange,
} from './createExternalSessionStatusDemandReconciler';

function replace(
    clientConnectionId: string,
    revision: number,
    entries: ReadonlyArray<Readonly<{
        sessionId: string;
        linkGeneration: string;
        demand: 'loaded' | 'visible' | 'open';
    }>>,
) {
    return {
        v: 1 as const,
        type: 'replace' as const,
        clientConnectionId,
        revision,
        entries,
    };
}

describe('createExternalSessionStatusDemandReconciler', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('unions two clients by current qualified link without duplicating fallback acquisition', async () => {
        const changes: ExternalSessionStatusDemandChange[] = [];
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async ({ sessionId, linkGeneration }) => (
                sessionId === 'session-1' && linkGeneration === 'generation-1'
            ),
            onDemandChanges: async (batch) => {
                changes.push(...batch);
            },
        });

        await reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-1',
            demand: 'loaded',
        }]));
        await reconciler.accept(replace('client-2', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-1',
            demand: 'open',
        }]));

        expect(changes).toEqual([
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-1',
                demand: 'loaded',
            },
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-1',
                demand: 'open',
            },
        ]);
    });

    it('rejects stale revisions and stale link generations', async () => {
        const onDemandChanges = vi.fn(async () => {});
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async ({ linkGeneration }) => linkGeneration === 'generation-current',
            onDemandChanges,
        });

        await expect(reconciler.accept(replace('client-1', 3, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]))).resolves.toEqual({ state: 'applied', admittedEntries: 1 });
        await expect(reconciler.accept(replace('client-1', 2, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'open',
        }]))).resolves.toEqual({ state: 'stale-revision' });
        await expect(reconciler.accept(replace('client-2', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-old',
            demand: 'open',
        }]))).resolves.toEqual({ state: 'applied', admittedEntries: 0 });

        expect(onDemandChanges).toHaveBeenCalledTimes(1);
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]);
    });

    it('revalidates an admitted identity on every replace and removes it after relink', async () => {
        const isCurrentLink = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const onDemandChanges = vi.fn(async () => {});
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink,
            onDemandChanges,
        });

        await expect(reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'loaded',
        }]))).resolves.toEqual({ state: 'applied', admittedEntries: 1 });
        await expect(reconciler.accept(replace('client-1', 2, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'open',
        }]))).resolves.toEqual({ state: 'applied', admittedEntries: 0 });

        expect(isCurrentLink).toHaveBeenCalledTimes(2);
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: null,
        }]);
    });

    it('retains desired demand and retries after a demand callback rejects without another message', async () => {
        vi.useFakeTimers();
        const onDemandChanges = vi.fn()
            .mockRejectedValueOnce(new Error('projection unavailable'))
            .mockResolvedValue(undefined);
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });

        await expect(reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'loaded',
        }]))).rejects.toThrow('projection unavailable');
        expect(reconciler.readDemand({
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
        })).toBe('loaded');

        await vi.advanceTimersByTimeAsync(250);

        expect(onDemandChanges).toHaveBeenCalledTimes(2);
        expect(onDemandChanges).toHaveBeenLastCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'loaded',
        }]);
        await reconciler.dispose();
    });

    it('keeps the applied union uncertain and retries the whole desired diff without another message', async () => {
        vi.useFakeTimers();
        const applied = new Set<string>();
        const onDemandChanges = vi.fn()
            .mockImplementationOnce(async (batch: readonly ExternalSessionStatusDemandChange[]) => {
                const first = batch[0];
                if (first) applied.add(first.sessionId);
                throw new Error('second admission failed');
            })
            .mockImplementationOnce(async (batch: readonly ExternalSessionStatusDemandChange[]) => {
                for (const change of batch) applied.add(change.sessionId);
            });
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });
        const entries = [
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'visible' as const,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'generation-current',
                demand: 'visible' as const,
            },
        ];

        await expect(reconciler.accept(replace('client-1', 1, entries)))
            .rejects.toThrow('second admission failed');
        expect(reconciler.readDemand({
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
        })).toBe('visible');

        await vi.advanceTimersByTimeAsync(250);

        expect(applied).toEqual(new Set(['session-1', 'session-2']));
        expect(onDemandChanges.mock.calls[1]?.[0]).toHaveLength(2);
        await expect(reconciler.accept(replace('client-1', 1, entries)))
            .resolves.toEqual({ state: 'stale-revision' });
        expect(onDemandChanges).toHaveBeenCalledTimes(2);
        await reconciler.dispose();
    });

    it('supersedes a failed partial apply with disconnect cleanup', async () => {
        vi.useFakeTimers();
        const applied = new Set<string>();
        const onDemandChanges = vi.fn()
            .mockImplementationOnce(async (batch: readonly ExternalSessionStatusDemandChange[]) => {
                const first = batch[0];
                if (first?.demand) applied.add(first.sessionId);
                throw new Error('second admission failed');
            })
            .mockImplementation(async (batch: readonly ExternalSessionStatusDemandChange[]) => {
                for (const change of batch) {
                    if (change.demand) {
                        applied.add(change.sessionId);
                    } else {
                        applied.delete(change.sessionId);
                    }
                }
            });
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });

        await expect(reconciler.accept(replace('client-1', 1, [
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'visible',
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'generation-current',
                demand: 'visible',
            },
        ]))).rejects.toThrow('second admission failed');
        expect(applied).toEqual(new Set(['session-1']));

        await expect(reconciler.accept({
            v: 1,
            type: 'disconnect',
            clientConnectionId: 'client-1',
        })).resolves.toEqual({ state: 'applied', admittedEntries: 0 });

        expect(applied).toEqual(new Set());
        expect(onDemandChanges).toHaveBeenCalledTimes(2);
        expect(onDemandChanges.mock.calls[1]?.[0]).toEqual([
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: null,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'generation-current',
                demand: null,
            },
        ]);
        await vi.runAllTimersAsync();
        expect(onDemandChanges).toHaveBeenCalledTimes(2);
        await reconciler.dispose();
    });

    it('supersedes an uncertain apply with the latest newer replace revision', async () => {
        vi.useFakeTimers();
        const onDemandChanges = vi.fn()
            .mockRejectedValueOnce(new Error('projection unavailable'))
            .mockResolvedValue(undefined);
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });

        await expect(reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]))).rejects.toThrow('projection unavailable');

        await expect(reconciler.accept(replace('client-1', 2, [{
            sessionId: 'session-2',
            linkGeneration: 'generation-current',
            demand: 'open',
        }]))).resolves.toEqual({ state: 'applied', admittedEntries: 1 });

        expect(onDemandChanges).toHaveBeenNthCalledWith(2, [
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: null,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'generation-current',
                demand: 'open',
            },
        ]);
        await vi.runAllTimersAsync();
        expect(onDemandChanges).toHaveBeenCalledTimes(2);
        await reconciler.dispose();
    });

    it('revalidates and re-emits retained demand for runtime-generation refresh', async () => {
        const isCurrentLink = vi.fn(async () => true);
        const onDemandChanges = vi.fn(async () => {});
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink,
            onDemandChanges,
        });
        await reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]));
        onDemandChanges.mockClear();

        await reconciler.refreshCurrentDemand();

        expect(isCurrentLink).toHaveBeenCalledTimes(2);
        expect(onDemandChanges).toHaveBeenCalledOnce();
        expect(onDemandChanges).toHaveBeenCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]);
    });

    it('releases and reacquires retained fallback demand after credential invalidation', async () => {
        const onDemandChanges = vi.fn(async () => {});
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });
        await reconciler.accept(replace('client-1', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]));
        onDemandChanges.mockClear();

        await (reconciler as typeof reconciler & {
            reconcileCredentialInvalidation(): Promise<void>;
        }).reconcileCredentialInvalidation();

        expect(onDemandChanges).toHaveBeenNthCalledWith(1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: null,
        }]);
        expect(onDemandChanges).toHaveBeenNthCalledWith(2, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
            demand: 'visible',
        }]);
        expect(reconciler.readDemand({
            sessionId: 'session-1',
            linkGeneration: 'generation-current',
        })).toBe('visible');
    });

    it('falls back for loaded and open demand, then clears only after the final client disconnects', async () => {
        const changes: ExternalSessionStatusDemandChange[] = [];
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges: async (batch) => {
                changes.push(...batch);
            },
        });

        await reconciler.accept(replace('client-loaded', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-1',
            demand: 'loaded',
        }]));
        await reconciler.accept(replace('client-open', 1, [{
            sessionId: 'session-1',
            linkGeneration: 'generation-1',
            demand: 'open',
        }]));
        await reconciler.accept({
            v: 1,
            type: 'disconnect',
            clientConnectionId: 'client-open',
        });
        await reconciler.accept({
            v: 1,
            type: 'disconnect',
            clientConnectionId: 'client-loaded',
        });

        expect(changes.map((change) => change.demand)).toEqual([
            'loaded',
            'open',
            'loaded',
            null,
        ]);
    });

    it('has no transcript-follow side effect and rejects payloads above the protocol bound', async () => {
        const onDemandChanges = vi.fn(async () => {});
        const reconciler = createExternalSessionStatusDemandReconciler({
            isCurrentLink: async () => true,
            onDemandChanges,
        });
        const entries = Array.from({ length: 257 }, (_, index) => ({
            sessionId: `session-${index}`,
            linkGeneration: 'generation-1',
            demand: 'visible' as const,
        }));

        await expect(reconciler.accept(replace('client-1', 1, entries))).resolves.toEqual({
            state: 'invalid-message',
        });
        expect(onDemandChanges).not.toHaveBeenCalled();
        expect(Object.keys(reconciler).sort()).toEqual([
            'accept',
            'clear',
            'dispose',
            'readDemand',
            'reconcileCredentialInvalidation',
            'refreshCurrentDemand',
        ]);
    });
});
