import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function importStore() {
    return await import('./transcriptJumpHighlightStore');
}

describe('transcriptJumpHighlightStore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses a canonical duration within the 1200-1800ms spec window', async () => {
        const store = await importStore();
        expect(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS).toBeGreaterThanOrEqual(1200);
        expect(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS).toBeLessThanOrEqual(1800);
        expect(store.TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS).toBeGreaterThan(0);
        expect(store.TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS).toBeLessThan(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS);
    });

    it('records a highlight for a landed route-message-id jump with seq fallback identity', async () => {
        const store = await importStore();

        store.applyTranscriptJumpHighlightForJumpResult('session-1', {
            status: 'scrolled',
            target: { kind: 'route-message-id', routeMessageId: 'local:m-1', seqHint: 42 },
        });

        expect(store.readActiveTranscriptJumpHighlight()).toEqual({
            sessionId: 'session-1',
            routeMessageId: 'local:m-1',
            seq: 42,
            token: 1,
        });
    });

    it('records a highlight for a landed seq jump', async () => {
        const store = await importStore();

        store.applyTranscriptJumpHighlightForJumpResult('session-1', {
            status: 'window-rendered',
            target: { kind: 'seq', seq: 7 },
            windowId: 'w-1',
        });

        expect(store.readActiveTranscriptJumpHighlight()).toEqual({
            sessionId: 'session-1',
            routeMessageId: null,
            seq: 7,
            token: 1,
        });
    });

    it('matches rows by routeMessageId primary and seq fallback, scoped to the session', async () => {
        const store = await importStore();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 42 });
        const active = store.readActiveTranscriptJumpHighlight();
        expect(active).not.toBeNull();

        // routeMessageId is primary when both sides carry one.
        expect(store.isTranscriptJumpHighlightActiveForRow(active!, {
            sessionId: 's1', routeMessageId: 'local:m-1', seq: 999,
        })).toBe(true);
        expect(store.isTranscriptJumpHighlightActiveForRow(active!, {
            sessionId: 's1', routeMessageId: 'local:other', seq: 42,
        })).toBe(false);
        // seq fallback when the row has no routeMessageId.
        expect(store.isTranscriptJumpHighlightActiveForRow(active!, {
            sessionId: 's1', routeMessageId: null, seq: 42,
        })).toBe(true);
        // session scoping.
        expect(store.isTranscriptJumpHighlightActiveForRow(active!, {
            sessionId: 's2', routeMessageId: 'local:m-1', seq: 42,
        })).toBe(false);
    });

    it('increments the token when the same row is jumped to again so consumers can retrigger', async () => {
        const store = await importStore();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });
        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });

        expect(store.readActiveTranscriptJumpHighlight()?.token).toBe(2);
    });

    it('auto-expires the highlight after the canonical duration', async () => {
        const store = await importStore();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });
        vi.advanceTimersByTime(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - 1);
        expect(store.readActiveTranscriptJumpHighlight()).not.toBeNull();

        vi.advanceTimersByTime(1);
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();
    });

    it('keeps a retriggered highlight alive for its full duration', async () => {
        const store = await importStore();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });
        vi.advanceTimersByTime(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - 100);
        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-2', seq: 2 });

        vi.advanceTimersByTime(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - 1);
        expect(store.readActiveTranscriptJumpHighlight()?.routeMessageId).toBe('local:m-2');

        vi.advanceTimersByTime(1);
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();
    });

    it('clears eagerly and cancels the pending expiry', async () => {
        const store = await importStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribeToTranscriptJumpHighlight(listener);

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });
        expect(listener).toHaveBeenCalledTimes(1);

        store.clearTranscriptJumpHighlight();
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(store.TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS * 2);
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: 'local:m-1', seq: 1 });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('re-renders only the target row subscriber when a highlight is set', async () => {
        const store = await importStore();
        const renderCounts = { target: 0, other: 0 };

        function Probe(props: { id: 'target' | 'other'; seq: number }) {
            renderCounts[props.id] += 1;
            store.useTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: null, seq: props.seq });
            return null;
        }

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(React.createElement(
                React.Fragment,
                null,
                React.createElement(Probe, { id: 'target', key: 'target', seq: 1 }),
                React.createElement(Probe, { id: 'other', key: 'other', seq: 2 }),
            ));
        });
        const baseline = { ...renderCounts };

        act(() => {
            store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: null, seq: 1 });
        });
        expect(renderCounts.target).toBe(baseline.target + 1);
        expect(renderCounts.other).toBe(baseline.other);

        act(() => {
            store.clearTranscriptJumpHighlight();
        });
        expect(renderCounts.target).toBe(baseline.target + 2);
        expect(renderCounts.other).toBe(baseline.other);

        act(() => {
            tree?.unmount();
        });
    });

    it('ignores invalid identities instead of highlighting arbitrary rows', async () => {
        const store = await importStore();

        store.setTranscriptJumpHighlight({ sessionId: '   ', routeMessageId: 'local:m-1', seq: 1 });
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: null, seq: null });
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();

        store.setTranscriptJumpHighlight({ sessionId: 's1', routeMessageId: '  ', seq: Number.NaN });
        expect(store.readActiveTranscriptJumpHighlight()).toBeNull();
    });
});
