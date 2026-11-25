import { describe, expect, it } from 'vitest';

import { __testables } from './uiWebMetro';

describe('uiWebMetro spawn env', () => {
    it('forces CI=1 when running with --no-dev', () => {
        const env = __testables.resolveUiWebMetroSpawnEnv({
            env: { NODE_ENV: 'test', BABEL_ENV: 'development' },
            tmpDir: '/tmp/ui-web-metro',
            metroCacheVersionBust: 'bust',
            noDev: true,
        });
        expect(env).toMatchObject({ NODE_ENV: 'production', BABEL_ENV: 'production', CI: '1' });
        expect(env.EXPO_NO_INTERACTIVE).toBe('1');
    });

    it('starts a development Expo child from a Vitest environment', () => {
        const parentEnv = { NODE_ENV: 'test', BABEL_ENV: 'test' };
        const env = __testables.resolveUiWebMetroSpawnEnv({
            env: parentEnv,
            tmpDir: '/tmp/ui-web-metro',
            metroCacheVersionBust: 'bust',
            noDev: false,
        });
        expect(env).toMatchObject({ NODE_ENV: 'development', BABEL_ENV: 'development' });
        expect(parentEnv).toEqual({ NODE_ENV: 'test', BABEL_ENV: 'test' });
        expect(env.CI).toBeUndefined();
        expect(env.EXPO_NO_INTERACTIVE).toBe('1');
    });
});
