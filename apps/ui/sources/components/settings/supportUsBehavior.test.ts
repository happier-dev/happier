import { describe, expect, it } from 'vitest';

import { resolveSupportUsAction } from './supportUsBehavior';

describe('resolveSupportUsAction', () => {
    it('opens GitHub when user already has pro entitlement', () => {
        expect(resolveSupportUsAction({ isPro: true })).toBe('github');
    });

    it('opens paywall when user is not pro', () => {
        expect(resolveSupportUsAction({ isPro: false })).toBe('paywall');
    });
});
