import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const { getConfig } = require('@expo/config');
const { getAsyncRoutesFromExpoConfig } = require('@expo/cli/build/src/start/server/middleware/metroOptions');

test('production web routes load on demand while native and development keep synchronous routes', () => {
    // Resolve the real app/plugin configuration through Expo's own option owner.
    const { exp } = getConfig(uiRoot);
    assert.equal(exp.web.output, 'single', 'preserve SPA and desktop deep-link hosting');
    assert.equal(getAsyncRoutesFromExpoConfig(exp, 'production', 'web'), true,
        'production must not synchronously require every settings, lab and session route');
    for (const mode of ['development', 'production']) {
        for (const platform of ['ios', 'android']) {
            assert.equal(getAsyncRoutesFromExpoConfig(exp, mode, platform), false);
        }
    }
    assert.equal(getAsyncRoutesFromExpoConfig(exp, 'development', 'web'), false,
        'preserve the existing single-graph development Metro memory policy');
});
