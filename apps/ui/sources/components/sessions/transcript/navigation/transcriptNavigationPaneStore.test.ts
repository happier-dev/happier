import { describe, expect, it, vi } from 'vitest';

import {
    awaitTranscriptNavigationJumpHandler,
    createEmptyTranscriptNavigationPaneSnapshot,
    createTranscriptNavigationPaneStore,
    readTranscriptNavigationJumpHandler,
    transcriptNavigationPaneStore,
} from './transcriptNavigationPaneStore';

describe('transcript navigation pane store', () => {
    it('starts with an empty per-session snapshot', () => {
        const store = createTranscriptNavigationPaneStore();

        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));
        expect(store.get('s1')).toBe(store.get('s1'));
    });

    it('carries only the session jump handler, never entries or the reader position', () => {
        const store = createTranscriptNavigationPaneStore();
        const onEntryPress = vi.fn();

        store.set('s1', { onEntryPress });

        expect(Object.keys(store.get('s1')).sort()).toEqual(['onEntryPress', 'sessionId']);
        expect(store.get('s1').onEntryPress).toBe(onEntryPress);
    });

    it('notifies subscribers when a session handler changes and resets on null', () => {
        const store = createTranscriptNavigationPaneStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe('s1', listener);
        const onEntryPress = vi.fn();

        store.set('s1', { onEntryPress });

        expect(listener).toHaveBeenCalledTimes(1);

        store.set('s1', null);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));

        unsubscribe();
        store.set('s1', { onEntryPress });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps session snapshots isolated', () => {
        const store = createTranscriptNavigationPaneStore();
        const s1Listener = vi.fn();
        const s2Listener = vi.fn();

        store.subscribe('s1', s1Listener);
        store.subscribe('s2', s2Listener);

        store.set('s1', { onEntryPress: vi.fn() });

        expect(s1Listener).toHaveBeenCalledTimes(1);
        expect(s2Listener).not.toHaveBeenCalled();
        expect(store.get('s2')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s2'));
    });
});

describe('awaitTranscriptNavigationJumpHandler', () => {
    it('yields a task before taking an already-registered handler so a reveal can commit first', async () => {
        transcriptNavigationPaneStore.set('await-1', null);
        const onEntryPress = vi.fn();
        transcriptNavigationPaneStore.set('await-1', { onEntryPress });

        const pending = awaitTranscriptNavigationJumpHandler('await-1');
        let settled = false;
        void pending.then(() => {
            settled = true;
        });

        expect(settled).toBe(false);
        expect(await pending).toBe(onEntryPress);
        transcriptNavigationPaneStore.set('await-1', null);
    });

    it('resolves with the handler a revealed host publishes after the press', async () => {
        transcriptNavigationPaneStore.set('await-2', null);
        expect(readTranscriptNavigationJumpHandler('await-2')).toBeNull();

        const pending = awaitTranscriptNavigationJumpHandler('await-2');
        const onEntryPress = vi.fn();
        transcriptNavigationPaneStore.set('await-2', { onEntryPress });

        expect(await pending).toBe(onEntryPress);
        transcriptNavigationPaneStore.set('await-2', null);
    });

    it('gives up with null once the wait budget expires so the press can report not-found', async () => {
        transcriptNavigationPaneStore.set('await-3', null);

        expect(await awaitTranscriptNavigationJumpHandler('await-3', { timeoutMs: 0 })).toBeNull();
    });
});
