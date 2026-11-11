import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    publishNewSessionStartedNotice,
    readNewSessionStartedNotice,
    resetNewSessionStartedNoticeForTests,
    subscribeNewSessionStartedNotice,
} from './newSessionStartedNotice';

describe('newSessionStartedNotice', () => {
    afterEach(() => resetNewSessionStartedNoticeForTests());

    it('reaches a composer that is showing, and names the latest started Session', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeNewSessionStartedNotice(listener);

        publishNewSessionStartedNotice({ href: '/session/first' });
        publishNewSessionStartedNotice({ href: '/session/second' });

        expect(listener).toHaveBeenCalledTimes(2);
        expect(readNewSessionStartedNotice()?.href).toBe('/session/second');
        unsubscribe();
    });

    it('does not resurface a launch that finished with no composer showing', () => {
        publishNewSessionStartedNotice({ href: '/session/unseen' });

        const unsubscribe = subscribeNewSessionStartedNotice(() => {});
        expect(readNewSessionStartedNotice()).toBeNull();
        unsubscribe();
    });

    it('forgets the notice when the last composer leaves', () => {
        const unsubscribe = subscribeNewSessionStartedNotice(() => {});
        publishNewSessionStartedNotice({ href: '/session/seen' });
        unsubscribe();

        const next = subscribeNewSessionStartedNotice(() => {});
        expect(readNewSessionStartedNotice()).toBeNull();
        next();
    });
});
