import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

test('vendored Unistyles web runtime tolerates hosts without the Screen Orientation API', (t) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const previousGlobals = {
        document: globalThis.document,
        screen: globalThis.screen,
        window: globalThis.window,
    };
    const originalLoad = Module._load;

    t.after(() => {
        Module._load = originalLoad;
        globalThis.document = previousGlobals.document;
        globalThis.screen = previousGlobals.screen;
        globalThis.window = previousGlobals.window;
        dom.window.close();
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.screen = dom.window.screen;
    let portraitViewport = true;
    dom.window.matchMedia = (query) => ({
        matches: query === '(orientation: portrait)' && portraitViewport,
        addEventListener() {},
        removeEventListener() {},
    });

    // React Native is a platform boundary here. The web runtime only needs these StyleSheet
    // functions while its real orientation owner remains loaded from the installed package.
    Module._load = function loadWithReactNativeWebBoundary(request, parent, isMain) {
        if (request === 'react-native') {
            return {
                StyleSheet: {
                    compose() {},
                    flatten() {},
                    hairlineWidth: 1,
                },
            };
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    const packageJsonPath = require.resolve('react-native-unistyles/package.json');
    const runtimePath = path.join(path.dirname(packageJsonPath), 'lib', 'commonjs', 'web', 'index.js');
    const { UnistylesRuntime } = require(runtimePath);

    assert.equal(dom.window.screen.orientation, undefined);
    assert.equal(UnistylesRuntime.orientation, 'portrait');
    portraitViewport = false;
    assert.equal(UnistylesRuntime.orientation, 'landscape');

    Object.defineProperty(dom.window.screen, 'orientation', {
        configurable: true,
        value: { type: 'landscape-primary' },
    });
    assert.equal(UnistylesRuntime.orientation, 'landscape');
});
