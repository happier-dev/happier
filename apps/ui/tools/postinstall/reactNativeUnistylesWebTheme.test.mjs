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
    let colorScheme = 'light';
    const mediaQueries = new Map();
    dom.window.matchMedia = (query) => {
        if (!mediaQueries.has(query)) {
            const listeners = new Set();
            mediaQueries.set(query, {
                get matches() { return query === `(prefers-color-scheme: ${colorScheme})`; },
                addEventListener(_, listener) { listeners.add(listener); },
                removeEventListener(_, listener) { listeners.delete(listener); },
                notify() { for (const listener of listeners) listener({ matches: this.matches }); },
            });
        }
        return mediaQueries.get(query);
    };

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
    const { useUnistyles } = require(path.join(packageDir, 'lib/commonjs/core/useUnistyles.js'));
    const { ScopedThemeContext } = require(path.join(packageDir, 'lib/commonjs/components/ScopedThemeContext.js'));
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

    await t.test('unchanged themes skip memoized child renders and theme-keyed derivations', () => {
        let renders = 0;
        let derivations = 0;
        const Child = React.memo(function Child({ theme }) {
            renders += 1;
            return React.createElement('span', null, theme.tone);
        });
        function Parent() {
            const { theme } = useUnistyles();
            React.useMemo(() => { derivations += 1; return theme.tone; }, [theme]);
            return React.createElement(Child, { theme });
        }
        flushSync(() => root.render(React.createElement(Parent)));
        const initialRenders = renders;
        const initialDerivations = derivations;
        for (let tick = 0; tick < 5; tick += 1) {
            flushSync(() => root.render(React.createElement(Parent, { tick })));
        }
        assert.equal(renders - initialRenders, 0, 'unrelated parent renders must not invalidate the theme child');
        assert.equal(derivations - initialDerivations, 0, 'unrelated parent renders must not recompute theme-keyed work');
        flushSync(() => UnistylesRuntime.setTheme('light'));
        assert.equal(renders - initialRenders, 1);
        assert.equal(derivations - initialDerivations, 1);
        assert.equal(dom.window.document.getElementById('root').textContent, 'light');
        flushSync(() => UnistylesRuntime.updateTheme('light', () => ({ tone: 'updated-light' })));
        assert.equal(renders - initialRenders, 2);
        assert.equal(dom.window.document.getElementById('root').textContent, 'updated-light');
    });

    await t.test('runtime properties first read after a stable theme render still subscribe', () => {
        flushSync(() => {
            UnistylesRuntime.updateTheme('light', () => ({ tone: 'light' }));
            UnistylesRuntime.setTheme('light');
        });
        function RuntimeProbe({ reading }) {
            const { theme, rt } = useUnistyles();
            return React.createElement('span', null, `${theme.tone}:${reading ? rt.colorScheme : 'unread'}`);
        }
        flushSync(() => root.render(React.createElement(RuntimeProbe, { reading: false })));
        flushSync(() => root.render(React.createElement(RuntimeProbe, { reading: true })));
        flushSync(() => {
            colorScheme = 'dark';
            for (const media of mediaQueries.values()) media.notify();
        });
        assert.equal(dom.window.document.getElementById('root').textContent, 'light:dark');
    });

    await t.test('adaptive and scoped theme transitions update memoized children', () => {
        let renders = 0;
        const Child = React.memo(function Child({ theme }) {
            renders += 1;
            return React.createElement('span', null, theme.tone);
        });
        function Parent() {
            const { theme } = useUnistyles();
            return React.createElement(Child, { theme });
        }
        flushSync(() => root.render(React.createElement(Parent)));
        flushSync(() => UnistylesRuntime.setAdaptiveThemes(true));
        assert.equal(dom.window.document.getElementById('root').textContent, 'dark');
        const beforeSwitch = renders;
        flushSync(() => {
            colorScheme = 'light';
            for (const media of mediaQueries.values()) media.notify();
        });
        assert.equal(renders - beforeSwitch, 1);
        assert.equal(dom.window.document.getElementById('root').textContent, 'light');
        const renderScoped = (name) => flushSync(() => root.render(
            React.createElement(ScopedThemeContext.Provider, { value: { name } }, React.createElement(Parent)),
        ));
        renderScoped('dark');
        assert.equal(dom.window.document.getElementById('root').textContent, 'dark');
        renderScoped('light');
        assert.equal(dom.window.document.getElementById('root').textContent, 'light');
        renderScoped(undefined);
        assert.equal(dom.window.document.getElementById('root').textContent, 'light');
    });
});
