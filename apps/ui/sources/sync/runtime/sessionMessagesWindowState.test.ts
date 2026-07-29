import { describe, expect, it } from 'vitest';

import {
    activateSessionMessagesWindow,
    applySessionMessagesWindowPage,
    createInactiveSessionMessagesWindowState,
    resetSessionMessagesWindowForLiveTail,
    resetSessionMessagesWindowForSessionSwitch,
} from './sessionMessagesWindowState';

describe('sessionMessagesWindowState', () => {
    it('tracks lifecycle epoch across activations and live-tail resets without page updates claiming ownership changes', () => {
        const inactive = createInactiveSessionMessagesWindowState();

        const active = activateSessionMessagesWindow(inactive, {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 100,
            olderCursor: 100,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });
        const paged = applySessionMessagesWindowPage(active, {
            windowId: 'window-1',
            direction: 'older',
            messages: [{ seq: 99 }],
            nextCursor: 99,
            hasMore: true,
        });
        const reset = resetSessionMessagesWindowForLiveTail(paged);

        expect(inactive.lifecycleEpoch).toBe(0);
        expect(active.lifecycleEpoch).toBe(1);
        expect(paged.lifecycleEpoch).toBe(1);
        expect(reset.lifecycleEpoch).toBe(2);
    });

    it('tracks target-window older and newer cursors separately', () => {
        const active = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 98,
            windowMaxSeq: 102,
            olderCursor: 98,
            newerCursor: 102,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        const afterOlder = applySessionMessagesWindowPage(active, {
            windowId: 'window-1',
            direction: 'older',
            messages: [{ seq: 95 }, { seq: 96 }],
            nextCursor: 95,
            hasMore: false,
        });

        expect(afterOlder).toMatchObject({
            windowMinSeq: 95,
            windowMaxSeq: 102,
            olderCursor: 95,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });

        const afterNewer = applySessionMessagesWindowPage(afterOlder, {
            windowId: 'window-1',
            direction: 'newer',
            messages: [{ seq: 104 }, { seq: 105 }],
            nextCursor: 105,
            hasMore: false,
        });

        expect(afterNewer).toMatchObject({
            windowMinSeq: 95,
            windowMaxSeq: 105,
            olderCursor: 95,
            newerCursor: 105,
            hasMoreOlder: false,
            hasMoreNewer: false,
        });
    });

    it('does not expose or mutate tail pagination cursor fields by shape', () => {
        const tailPagination = { beforeSeq: 80, hasMoreOlder: true };
        const active = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 100,
            olderCursor: 100,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        const next = applySessionMessagesWindowPage(active, {
            windowId: 'window-1',
            direction: 'older',
            messages: [{ seq: 99 }],
            nextCursor: 99,
            hasMore: true,
        });

        expect(tailPagination).toEqual({ beforeSeq: 80, hasMoreOlder: true });
        expect(next).not.toHaveProperty('beforeSeq');
        expect(next).not.toHaveProperty('paginationSupported');
    });

    it('uses newest-wins semantics for repeated jumps and ignores stale page updates', () => {
        const first = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 100,
            olderCursor: 100,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });
        const second = activateSessionMessagesWindow(first, {
            windowId: 'window-2',
            targetSeq: 500,
            windowMinSeq: 498,
            windowMaxSeq: 502,
            olderCursor: 498,
            newerCursor: 502,
            hasMoreOlder: true,
            hasMoreNewer: false,
            activatedAtMs: 20,
        });

        const stale = applySessionMessagesWindowPage(second, {
            windowId: 'window-1',
            direction: 'older',
            messages: [{ seq: 90 }],
            nextCursor: 90,
            hasMore: false,
        });

        expect(second).toMatchObject({
            isWindowMode: true,
            windowId: 'window-2',
            targetSeq: 500,
            windowMinSeq: 498,
            windowMaxSeq: 502,
        });
        expect(stale).toBe(second);
    });

    it('resets target-window mode when returning to live tail', () => {
        const active = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 101,
            olderCursor: 100,
            newerCursor: 101,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        expect(resetSessionMessagesWindowForLiveTail(active)).toEqual(createInactiveSessionMessagesWindowState(2));
    });

    it('resets target-window mode when switching sessions', () => {
        const active = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-1',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 101,
            olderCursor: 100,
            newerCursor: 101,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        expect(resetSessionMessagesWindowForSessionSwitch(active)).toEqual(createInactiveSessionMessagesWindowState(2));
    });
});
