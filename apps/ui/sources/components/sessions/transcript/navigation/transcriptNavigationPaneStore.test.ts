import { describe, expect, it, vi } from 'vitest';

import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';
import {
    createEmptyTranscriptNavigationPaneSnapshot,
    createTranscriptNavigationPaneStore,
} from './transcriptNavigationPaneStore';

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'sessionId' | 'seq'>): TranscriptNavigationEntry {
    const { id, sessionId, seq, ...rest } = overrides;
    return {
        id,
        sessionId,
        seq,
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: id,
        promptPreview: id,
        responsePreview: null,
        createdAtMs: null,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
        ...rest,
    };
}

describe('transcript navigation pane store', () => {
    it('starts with an empty per-session snapshot', () => {
        const store = createTranscriptNavigationPaneStore();

        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));
        expect(store.get('s1')).toBe(store.get('s1'));
    });

    it('notifies subscribers when a session snapshot changes and resets on null', () => {
        const store = createTranscriptNavigationPaneStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe('s1', listener);
        const entries = [entry({ id: 'turn-1', sessionId: 's1', seq: 1 })];
        const onEntryPress = vi.fn();

        store.set('s1', {
            activeEntryId: 'turn-1',
            entries,
            onEntryPress,
        });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.get('s1')).toMatchObject({
            activeEntryId: 'turn-1',
            entries,
            sessionId: 's1',
        });
        expect(store.get('s1').onEntryPress).toBe(onEntryPress);

        store.set('s1', null);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.get('s1')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s1'));

        unsubscribe();
        store.set('s1', {
            activeEntryId: null,
            entries,
            onEntryPress,
        });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps session snapshots isolated', () => {
        const store = createTranscriptNavigationPaneStore();
        const s1Listener = vi.fn();
        const s2Listener = vi.fn();
        const entries = [entry({ id: 'turn-1', sessionId: 's1', seq: 1 })];

        store.subscribe('s1', s1Listener);
        store.subscribe('s2', s2Listener);

        store.set('s1', {
            activeEntryId: null,
            entries,
            onEntryPress: vi.fn(),
        });

        expect(s1Listener).toHaveBeenCalledTimes(1);
        expect(s2Listener).not.toHaveBeenCalled();
        expect(store.get('s2')).toEqual(createEmptyTranscriptNavigationPaneSnapshot('s2'));
    });
});

describe('transcript navigation pane subscriber signal', () => {
    it('reports per-session subscriber presence reactively as consumers attach and detach', () => {
        const store = createTranscriptNavigationPaneStore();
        const countListener = vi.fn();

        expect(store.hasSubscribers('s1')).toBe(false);
        const stopCountWatch = store.subscribeSubscriberPresence('s1', countListener);

        const unsubscribeA = store.subscribe('s1', vi.fn());
        expect(store.hasSubscribers('s1')).toBe(true);
        expect(countListener).toHaveBeenCalledTimes(1);

        const unsubscribeB = store.subscribe('s1', vi.fn());
        expect(store.hasSubscribers('s1')).toBe(true);

        unsubscribeA();
        expect(store.hasSubscribers('s1')).toBe(true);
        unsubscribeB();
        expect(store.hasSubscribers('s1')).toBe(false);
        expect(countListener).toHaveBeenCalledTimes(countListener.mock.calls.length);
        expect(countListener.mock.calls.length).toBeGreaterThanOrEqual(2);

        stopCountWatch();
        expect(store.hasSubscribers('s2')).toBe(false);
    });
});
