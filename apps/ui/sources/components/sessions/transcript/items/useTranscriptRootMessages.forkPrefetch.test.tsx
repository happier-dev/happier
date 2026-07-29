import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

const prefetchForkedTranscriptContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const forkPrefetchTestState = vi.hoisted(() => ({
    isLoaded: false,
    listeners: new Set<() => void>(),
}));

function setChildTranscriptLoaded(isLoaded: boolean): void {
    forkPrefetchTestState.isLoaded = isLoaded;
    for (const listener of [...forkPrefetchTestState.listeners]) listener();
}

vi.mock('@/sync/sync', () => ({
    sync: {
        prefetchForkedTranscriptContext: prefetchForkedTranscriptContextMock,
    },
}));

vi.mock('@/sync/domains/state/storage', () => {
    const subscribe = (listener: () => void) => {
        forkPrefetchTestState.listeners.add(listener);
        return () => forkPrefetchTestState.listeners.delete(listener);
    };
    const forkSnapshot = {
        segments: [
            {
                sessionId: 'parent',
                isReadOnlyContext: true,
                cutoffSeqInclusive: 3,
                messageIdsOldestFirst: [],
            },
            {
                sessionId: 'child',
                isReadOnlyContext: false,
                cutoffSeqInclusive: null,
                messageIdsOldestFirst: [],
            },
        ],
        combinedMessageIdsOldestFirst: [],
        combinedMessagesById: {},
        messageOriginById: {},
        isLoaded: false,
    };
    return {
        useForkedTranscriptSnapshot: () => forkSnapshot,
        useSessionTranscriptIds: () => React.useSyncExternalStore(
            subscribe,
            () => forkPrefetchTestState.isLoaded,
        ) ? { ids: [], isLoaded: true } : { ids: [], isLoaded: false },
        useSessionMessagesById: () => ({}),
        useSessionMessages: () => ({ messages: [], isLoaded: false }),
    };
});

import { useTranscriptRootMessages } from './useTranscriptRootMessages';

function Probe(): null {
    useTranscriptRootMessages('child');
    return null;
}

describe('useTranscriptRootMessages fork context prefetch timing', () => {
    beforeEach(() => {
        prefetchForkedTranscriptContextMock.mockClear();
        forkPrefetchTestState.isLoaded = false;
        forkPrefetchTestState.listeners.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defers the fork parent-context prefetch until the child transcript load resolves (S-F)', async () => {
        // Live native S-F (2026-07-11): the prefetch fired once at mount, BEFORE the
        // child's initial (empty) /messages page resolved its pagination state, so the
        // sync-side "child fully paged" gate skipped the parent segment and nothing ever
        // retried — the pre-fork parent transcript never rendered. The hook must wait for
        // the child's load to settle and fire when it does.
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe));
        });

        // Child transcript still loading: firing now would be swallowed by the sync gate.
        expect(prefetchForkedTranscriptContextMock).not.toHaveBeenCalled();

        await act(async () => {
            setChildTranscriptLoaded(true);
        });

        expect(prefetchForkedTranscriptContextMock).toHaveBeenCalledTimes(1);
        expect(prefetchForkedTranscriptContextMock).toHaveBeenCalledWith('child');

        await act(async () => {
            tree?.unmount();
        });
    });
});
