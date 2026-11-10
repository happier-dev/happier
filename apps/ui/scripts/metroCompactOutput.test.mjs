// @happier-test-preparation source
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { transform } = require('@expo/metro-config/build/transform-worker/metro-transform-worker');

test('Metro emits compact development modules with working code and source maps on web and native', async () => {
    const { transformer } = require('../metro.config.js');
    const source = Buffer.from(`export function total(values) {
        let result = 0;
        for (let index = 0; index < values.length; index += 1) {
            result += values[index];
        }
        return result;
    }
    globalThis.bundleFixtureResult = total([1, 2, 3]);`);
    for (const platform of ['web', 'ios', 'android']) {
        const options = {
            dev: true, hot: false, minify: false, platform, type: 'module',
            experimentalImportSupport: false, inlineRequires: true,
            unstable_transformProfile: 'hermes-stable',
            customTransformOptions: { engine: 'hermes' },
        };
        const filename = path.join(uiRoot, 'sources/bundleFixture.ts');
        const baseline = await transform({ ...transformer, unstable_compactOutput: false }, uiRoot, filename, source, options);
        const actual = await transform(transformer, uiRoot, filename, source, options);
        const before = baseline.output[0].data;
        const after = actual.output[0].data;
        assert.ok(Buffer.byteLength(after.code) < Buffer.byteLength(before.code),
            `${platform} development output must omit formatting without a minifier pass`);
        assert.ok(after.map.length > 0, 'debugging keeps source mappings');
        const context = vm.createContext({ __DEV__: true });
        context.__d = factory => factory(context, undefined, undefined, undefined, { exports: {} }, {}, []);
        vm.runInContext(after.code, context);
        assert.equal(context.bundleFixtureResult, 6);
        console.log(JSON.stringify({ platform, beforeBytes: Buffer.byteLength(before.code), afterBytes: Buffer.byteLength(after.code) }));
    }
});
