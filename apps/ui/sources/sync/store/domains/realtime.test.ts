import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createRealtimeDomain, type RealtimeDomain } from './realtime';

describe('realtime sync-error publication', () => {
    it('notifies on an error and its recovery, but not on repeated already-clear success', () => {
        const store = createStore<RealtimeDomain>()((set) => createRealtimeDomain({ set }));
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        const initial = store.getState();

        store.getState().clearSyncError();
        store.getState().setSyncError(null);
        expect(store.getState()).toBe(initial);
        expect(notify).not.toHaveBeenCalled();

        const failure = { message: 'Unavailable', retryable: true, kind: 'network' as const, at: 1 };
        store.getState().setSyncError(failure);
        expect(store.getState().syncError).toBe(failure);
        expect(notify).toHaveBeenCalledTimes(1);
        const failed = store.getState();
        store.getState().setSyncError(failure);
        expect(store.getState()).toBe(failed);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().clearSyncError();
        expect(store.getState().syncError).toBeNull();
        expect(notify).toHaveBeenCalledTimes(2);
        const recovered = store.getState();
        store.getState().clearSyncError();
        expect(store.getState()).toBe(recovered);
        expect(notify).toHaveBeenCalledTimes(2);

        store.getState().setSyncError({ ...failure, at: 2 });
        expect(store.getState().syncError?.at).toBe(2);
        expect(notify).toHaveBeenCalledTimes(3);
        unsubscribe();
    });
});
