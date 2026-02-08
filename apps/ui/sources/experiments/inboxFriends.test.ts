import { describe, expect, it } from 'vitest';
import { isInboxFriendsEnabled } from './inboxFriends';

describe('isInboxFriendsEnabled', () => {
    it('requires both experiments and expInboxFriends toggles', () => {
        expect(isInboxFriendsEnabled({ experiments: false, expInboxFriends: true })).toBe(false);
        expect(isInboxFriendsEnabled({ experiments: false, expInboxFriends: false })).toBe(false);
        expect(isInboxFriendsEnabled({ experiments: true, expInboxFriends: false })).toBe(false);
        expect(isInboxFriendsEnabled({ experiments: true, expInboxFriends: true })).toBe(true);
    });
});
