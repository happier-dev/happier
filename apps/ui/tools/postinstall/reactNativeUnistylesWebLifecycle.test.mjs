import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

test('vendored Unistyles releases ScrollView nodes after updates and unmount', async (t) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
        pretendToBeVisual: true,
    });
    const names = ['window', 'document', 'screen', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', '__DEV__'];
    const previousGlobals = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
    const originalLoad = Module._load;
    let root;
    t.after(() => {
        root?.unmount();
        Module._load = originalLoad;
        for (const name of names) globalThis[name] = previousGlobals[name];
        dom.window.close();
    });
    for (const name of names) globalThis[name] = dom.window[name];
    globalThis.__DEV__ = false;
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

    const reactNativeWeb = require('react-native-web');
    // The installed web implementation consumes the real browser platform adapter.
    // All Unistyles registry, ref handling and React logic remain real.
    Module._load = function loadWebPlatform(request, parent, isMain) {
        return request === 'react-native'
            ? reactNativeWeb
            : originalLoad.call(this, request, parent, isMain);
    };
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { flushSync } = require('react-dom');
    const packageDir = path.dirname(require.resolve('react-native-unistyles/package.json'));
    const { StyleSheet } = require(path.join(packageDir, 'lib/commonjs/web/index.js'));
    const { services } = require(path.join(packageDir, 'lib/commonjs/web/services.js'));
    const { createUnistylesElement } = require(path.join(packageDir, 'lib/commonjs/core/createUnistylesElement.js'));
    StyleSheet.configure({ themes: { light: { colors: { text: 'black' } } }, settings: { initialTheme: 'light' } });
    const ScrollView = createUnistylesElement(reactNativeWeb.ScrollView);
    const style = { padding: 3 };
    root = createRoot(dom.window.document.getElementById('root'));
    for (let revision = 0; revision < 3; revision += 1) {
        flushSync(() => root.render(React.createElement(ScrollView, { style }, React.createElement(reactNativeWeb.Text, null, String(revision)))));
    }
    assert.equal(dom.window.document.getElementById('root').textContent, '2');
    flushSync(() => root.unmount());
    root = undefined;
    await Promise.resolve();
    await Promise.resolve();
    const retainedNodes = [...services.registry.stylesCounter.values()].flatMap((nodes) => [...nodes]);
    assert.equal(retainedNodes.filter((node) => !node.isConnected).length, 0);
});
