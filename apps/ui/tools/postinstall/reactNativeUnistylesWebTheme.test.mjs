import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

test('vendored Unistyles catches theme changes before the first theme subscription', async (t) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
        pretendToBeVisual: true,
    });
    const names = ['window', 'document', 'screen', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', '__DEV__'];
    const previousGlobals = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
    const originalLoad = Module._load;
    let root;
    t.after(async () => {
        root?.unmount();
        // React's Node host schedules pending browser work with setImmediate.
        // Keep the DOM globals alive until that queued host work has run.
        await new Promise((resolve) => setImmediate(resolve));
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
    const { StyleSheet, UnistylesRuntime } = require(path.join(packageDir, 'lib/commonjs/web/index.js'));
    const { useProxifiedUnistyles } = require(path.join(packageDir, 'lib/commonjs/core/useProxifiedUnistyles/useProxifiedUnistyles.js'));
    StyleSheet.configure({ themes: { light: { tone: 'light' }, dark: { tone: 'dark' } }, settings: { initialTheme: 'light' } });
    function Probe({ reading }) {
        const { proxifiedTheme } = useProxifiedUnistyles();
        return React.createElement('span', null, reading ? proxifiedTheme.tone : 'unsubscribed');
    }
    root = createRoot(dom.window.document.getElementById('root'));
    flushSync(() => root.render(React.createElement(Probe, { reading: false })));
    UnistylesRuntime.setTheme('dark');
    flushSync(() => root.render(React.createElement(Probe, { reading: true })));
    assert.equal(dom.window.document.getElementById('root').textContent, 'dark');
});
