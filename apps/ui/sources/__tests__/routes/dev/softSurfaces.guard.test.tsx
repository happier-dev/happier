import { afterEach, describe, expect, it, vi } from 'vitest';

import SoftSurfacesDevScreen from '@/app/dev/soft-surfaces';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('soft surface dev specimen admission', () => {
    it('does not render outside a dev or explicitly enabled debug build', () => {
        vi.stubGlobal('__DEV__', false);
        vi.stubEnv('EXPO_PUBLIC_DEBUG', '0');
        expect(SoftSurfacesDevScreen()).toBeNull();
    });
    it.each([{ dev: true, debug: '0' }, { dev: false, debug: '1' }])('admits the canonical dev/debug environment $dev/$debug', ({ dev, debug }) => {
        vi.stubGlobal('__DEV__', dev);
        vi.stubEnv('EXPO_PUBLIC_DEBUG', debug);
        expect(SoftSurfacesDevScreen()).not.toBeNull();
    });
});
