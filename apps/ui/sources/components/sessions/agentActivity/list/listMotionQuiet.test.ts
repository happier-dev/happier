import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIST_MOTION_SCROLL_IDLE_MS, createListMotionQuiet } from './listMotionQuiet';

/**
 * The quiet window decides one thing: may the list re-lay-out right now?
 *
 * It is tested without React because the answer must not depend on a render happening — a scroll
 * that ends while nothing re-renders still has to release the batch, and a listener is the only
 * way the list learns about it.
 */
describe('createListMotionQuiet', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts quiet, because a list nobody is touching may reflow', () => {
        expect(createListMotionQuiet().isQuiet()).toBe(true);
    });

    it('stays unquiet for the whole idle window after the last scroll event', () => {
        const quiet = createListMotionQuiet();

        quiet.reportScrollActivity();
        expect(quiet.isQuiet()).toBe(false);

        // A scroll that keeps producing events keeps the window open: the deferral has to outlast
        // a flick, not just the first frame of one.
        vi.advanceTimersByTime(LIST_MOTION_SCROLL_IDLE_MS - 1);
        quiet.reportScrollActivity();
        vi.advanceTimersByTime(LIST_MOTION_SCROLL_IDLE_MS - 1);
        expect(quiet.isQuiet()).toBe(false);

        vi.advanceTimersByTime(1);
        expect(quiet.isQuiet()).toBe(true);
    });

    it('tells its listeners when the scroll settles, without a render to ask it', () => {
        const quiet = createListMotionQuiet();
        const listener = vi.fn();
        quiet.subscribe(listener);

        quiet.reportScrollActivity();
        // Nothing to say yet: going unquiet never releases a batch, only becoming quiet does.
        expect(listener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(LIST_MOTION_SCROLL_IDLE_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(quiet.isQuiet()).toBe(true);
    });

    it('holds while a pointer is over the list and releases on leave', () => {
        const quiet = createListMotionQuiet();
        const listener = vi.fn();
        quiet.subscribe(listener);

        quiet.setPointerInside(true);
        expect(quiet.isQuiet()).toBe(false);
        // Going busy is not news for a held batch, and repeating the same state is not an event
        // at all — a pointer crossing between two rows re-fires enter on some platforms.
        quiet.setPointerInside(true);
        expect(listener).not.toHaveBeenCalled();

        quiet.setPointerInside(false);
        expect(quiet.isQuiet()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('needs BOTH the pointer gone and the scroll settled before it is quiet again', () => {
        const quiet = createListMotionQuiet();

        quiet.setPointerInside(true);
        quiet.reportScrollActivity();

        vi.advanceTimersByTime(LIST_MOTION_SCROLL_IDLE_MS);
        expect(quiet.isQuiet()).toBe(false);

        quiet.setPointerInside(false);
        expect(quiet.isQuiet()).toBe(true);
    });

    it('drops its listeners and its pending timer when disposed', () => {
        const quiet = createListMotionQuiet();
        const listener = vi.fn();
        quiet.subscribe(listener);

        quiet.reportScrollActivity();
        quiet.dispose();
        vi.advanceTimersByTime(LIST_MOTION_SCROLL_IDLE_MS * 4);

        expect(listener).not.toHaveBeenCalled();
        expect(quiet.isQuiet()).toBe(true);
    });

    it('stops notifying an unsubscribed listener', () => {
        const quiet = createListMotionQuiet();
        const listener = vi.fn();
        const unsubscribe = quiet.subscribe(listener);

        unsubscribe();
        quiet.setPointerInside(true);
        quiet.setPointerInside(false);

        expect(listener).not.toHaveBeenCalled();
    });
});
