import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveWebappUrlFromServerUrl } from './resolveWebappUrlFromServerUrl';

describe('resolveWebappUrlFromServerUrl', () => {
    afterEach(() => vi.unstubAllEnvs());
    it('points the configured API at its build-profile web client', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
            home: { url: 'https://api.happier.dev', webappUrl: 'https://cloud.happier.dev' },
        }));
        expect(resolveWebappUrlFromServerUrl('https://api.happier.dev'))
            .toBe('https://cloud.happier.dev');
    });

    it('does not introduce a hosted destination without a profile', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', '');
        expect(resolveWebappUrlFromServerUrl('https://api.happier.dev')).toBe('https://api.happier.dev');
    });

    it('preserves a custom server origin', () => {
        expect(resolveWebappUrlFromServerUrl('https://stack.example.test/api'))
            .toBe('https://stack.example.test');
    });
});
