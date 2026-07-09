import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import {
    clearTranscriptNavigationVisibilityStore,
    createTranscriptNavigationVisibilityStore,
    getTranscriptNavigationVisibilityStore,
    useTranscriptNavigationVisibilitySnapshot,
} from './transcriptNavigationVisibilityStore';

describe('transcript navigation visibility store', () => {
    afterEach(async () => {
        await standardCleanup();
    });

    it('starts empty and reset(null) restores the empty snapshot', () => {
        const store = createTranscriptNavigationVisibilityStore({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-1', 'turn-2'],
        });

        store.set(null);

        expect(store.get()).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
    });

    it('does not notify or replace the snapshot when current and visible ids are equal', () => {
        const store = createTranscriptNavigationVisibilityStore();
        const listener = vi.fn();
        store.set({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'turn-2'],
        });
        const firstSnapshot = store.get();
        store.subscribe(listener);

        store.set({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'turn-2'],
        });

        expect(listener).not.toHaveBeenCalled();
        expect(store.get()).toBe(firstSnapshot);
    });

    it('notifies subscribers only for changed visibility facts and supports unsubscribe', () => {
        const store = createTranscriptNavigationVisibilityStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        store.set({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1'],
        });
        unsubscribe();
        store.set({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.get()).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });
    });

    it('dedupes visible ids so equality is based on the canonical current-visible set', () => {
        const store = createTranscriptNavigationVisibilityStore();
        store.set({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'turn-1', '', 'turn-2'],
        });

        expect(store.get()).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'turn-2'],
        });
    });

    it('exposes subscriber presence so hosts can skip DOM visibility measurement when unused', () => {
        const store = createTranscriptNavigationVisibilityStore();
        expect(store.hasSubscribers()).toBe(false);
        expect(store.subscriberCount()).toBe(0);

        const unsubscribe = store.subscribe(vi.fn());

        expect(store.hasSubscribers()).toBe(true);
        expect(store.subscriberCount()).toBe(1);

        unsubscribe();

        expect(store.hasSubscribers()).toBe(false);
        expect(store.subscriberCount()).toBe(0);
    });

    it('scopes default stores by session id and clears a host session on unmount', () => {
        const s1Store = getTranscriptNavigationVisibilityStore('session-1');
        const s2Store = getTranscriptNavigationVisibilityStore('session-2');
        s1Store.set({ currentAnchorId: 'turn-1', visibleAnchorIds: ['turn-1'] });
        s2Store.set({ currentAnchorId: 'turn-2', visibleAnchorIds: ['turn-2'] });

        expect(getTranscriptNavigationVisibilityStore('session-1').get()).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1'],
        });
        expect(getTranscriptNavigationVisibilityStore('session-2').get()).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });

        clearTranscriptNavigationVisibilityStore('session-1');

        expect(getTranscriptNavigationVisibilityStore('session-1').get()).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(getTranscriptNavigationVisibilityStore('session-2').get()).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });

        clearTranscriptNavigationVisibilityStore('session-2');
    });

    it('does not subscribe while the visibility snapshot hook is disabled', async () => {
        const store = createTranscriptNavigationVisibilityStore({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1'],
        });

        const hook = await renderHook(() =>
            useTranscriptNavigationVisibilitySnapshot(store, { enabled: false }));

        expect(hook.getCurrent()).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(store.subscriberCount()).toBe(0);

        await hook.unmount();
    });
});
