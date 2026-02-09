import { describe, expect, it } from 'vitest';

import { computeHasUnreadActivity } from './unread';

describe('unread', () => {
    it('does not treat pending activity as unread when committed seq is already viewed', () => {
        expect(computeHasUnreadActivity({
            sessionSeq: 5,
            pendingActivityAt: 100,
            lastViewedSessionSeq: 5,
            lastViewedPendingActivityAt: 0,
        })).toBe(false);
    });

    it('treats newer committed seq as unread', () => {
        expect(computeHasUnreadActivity({
            sessionSeq: 6,
            pendingActivityAt: 0,
            lastViewedSessionSeq: 5,
            lastViewedPendingActivityAt: 0,
        })).toBe(true);
    });
});

