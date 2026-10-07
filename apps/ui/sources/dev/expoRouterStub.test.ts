import { describe, expect, it } from 'vitest';

import { router, useRouter } from './expoRouterStub';

describe('default Expo Router boundary', () => {
    it('preserves the imperative router identity across hook reads', () => {
        // Expo Router 55 returns its exported singleton. A fresh router retires
        // route-bound plugin controllers on every Account-mode state update.
        expect(useRouter()).toBe(router);
        expect(useRouter()).toBe(router);
    });
});
