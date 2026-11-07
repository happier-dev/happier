import { describe, expect, it } from 'vitest';
import { moveInboxItem } from './inboxItemNavigation';
import type { InboxItem } from './inboxItems';

const rows = ['first', 'selected', 'next'].map(id => ({ key: id, view: 'needs_you',
    focus: { kind: 'session', id, serverId: 'home-a' },
} satisfies Pick<InboxItem, 'key' | 'view' | 'focus'>));

describe('Inbox item navigation', () => {
    it('moves in visible order and stops at the list boundaries', () => {
        expect(moveInboxItem(rows, null, 1)).toBe(rows[0]);
        expect(moveInboxItem(rows, null, -1)).toBe(rows[2]);
        expect(moveInboxItem(rows, 'selected', 1)).toBe(rows[2]);
        expect(moveInboxItem(rows, 'selected', -1)).toBe(rows[0]);
        expect(moveInboxItem(rows, 'next', 1)).toBe(rows[2]);
        expect(moveInboxItem([], null, 1)).toBeNull();
    });

});
