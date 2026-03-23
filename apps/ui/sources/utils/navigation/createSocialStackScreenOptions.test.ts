import { describe, expect, it } from 'vitest';

import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from './createSocialStackScreenOptions';

describe('createSocialStackScreenOptions', () => {
    const translate = (key: string) => key;

    it('uses the friends tab label for the friends stack header', () => {
        expect(createFriendsStackScreenOptions(translate)).toEqual({
            headerShown: false,
            headerTitle: 'tabs.friends',
            headerBackTitle: 'common.home',
        });
    });

    it('uses the inbox tab label for the inbox stack header', () => {
        expect(createInboxStackScreenOptions(translate)).toEqual({
            headerShown: false,
            headerTitle: 'tabs.inbox',
            headerBackTitle: 'common.home',
        });
    });
});
