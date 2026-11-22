import { Dimensions } from 'react-native';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { isHomeArrivalMotionPending } from '@/components/hub/homeArrival';

import { resolvePostAuthLanding } from './resolvePostAuthLanding';

describe('post-authentication landing', () => {
    beforeEach(() => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
    });
    afterEach(() => vi.restoreAllMocks());
    it('navigation follows the Team owner continuation without revealing Home or arming the tour', () => {
        const replace = vi.fn();
        const revealHome = vi.fn();
        resolvePostAuthLanding({
            replace, revealHome,
            teamContinuation: '/join/example-invitation',
            returnTo: '/auth/email/verify?token=other',
        });
        expect(replace.mock.calls).toEqual([['/join/example-invitation']]);
        expect(revealHome).not.toHaveBeenCalled();
        expect(isHomeArrivalMotionPending()).toBe(false);
    });

    it('lands a phone directly on Home with one navigation', () => {
        vi.mocked(Dimensions.get).mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const replace = vi.fn();
        resolvePostAuthLanding({ replace });
        expect(replace.mock.calls).toEqual([['/home']]);
    });

    it('preserves the admitted destination and its opaque query bytes', () => {
        const replace = vi.fn();
        const returnTo = '/auth/email/reset?home=https%3A%2F%2Fexample.test&token=demo%2Bopaque%2Fvalue';
        resolvePostAuthLanding({ replace, returnTo });
        expect(replace.mock.calls).toEqual([[returnTo]]);
    });

    it('falls back to Home on an inadmissible return and settles when there is no motion stage', () => {
        const replace = vi.fn();
        const revealHome = vi.fn(() => expect(isHomeArrivalMotionPending()).toBe(true));
        resolvePostAuthLanding({ replace, revealHome, returnTo: '//other.example.test/path' });
        expect(revealHome).toHaveBeenCalledTimes(1);
        expect(replace).not.toHaveBeenCalled();
        expect(isHomeArrivalMotionPending()).toBe(false);
    });

    it('arms the same Home arrival when sign-in completes on a separate callback route', () => {
        const replace = vi.fn(() => expect(isHomeArrivalMotionPending()).toBe(true));
        resolvePostAuthLanding({ replace });
        expect(replace.mock.calls).toEqual([['/']]);
        expect(isHomeArrivalMotionPending()).toBe(false);
    });
});
