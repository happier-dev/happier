import { describe, expect, it } from 'vitest';

import { __testables } from './uiWebMetro';

describe('uiWebMetro spawn env', () => {
    it('forces CI=1 when running with --no-dev', () => {
        const env = __testables.resolveUiWebMetroSpawnEnv({
            env: {},
            tmpDir: '/tmp/ui-web-metro',
            metroCacheVersionBust: 'bust',
            noDev: true,
        });
        expect(env.CI).toBe('1');
        expect(env.EXPO_NO_INTERACTIVE).toBe('1');
    });

    it('does not force CI when running with dev enabled', () => {
        const env = __testables.resolveUiWebMetroSpawnEnv({
            env: {},
            tmpDir: '/tmp/ui-web-metro',
            metroCacheVersionBust: 'bust',
            noDev: false,
        });
        expect(env.CI).toBeUndefined();
        expect(env.EXPO_NO_INTERACTIVE).toBe('1');
    });
});
