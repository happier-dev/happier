import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const PACKAGE_DIR = path.dirname(require.resolve('react-native-web/package.json'));
const LOCALE_MODULES = ['dist/modules/useLocale/index.js', 'dist/cjs/modules/useLocale/index.js'];

test('installed react-native-web LocaleProvider keeps its context value stable across equal-prop renders', (t) => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const previousGlobals = { window: globalThis.window, document: globalThis.document };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    t.after(() => {
        globalThis.window = previousGlobals.window;
        globalThis.document = previousGlobals.document;
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        dom.window.close();
    });

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = React;
    const { LocaleProvider, useLocaleContext } = require(path.join(PACKAGE_DIR, 'dist/cjs/modules/useLocale/index.js'));

    const seen = [];
    const Consumer = React.memo(function Consumer() {
        seen.push(useLocaleContext());
        return null;
    });
    const Parent = ({ tick }) =>
        React.createElement(LocaleProvider, { direction: 'ltr', locale: 'en-US' }, React.createElement(Consumer), tick);

    const root = createRoot(dom.window.document.getElementById('root'));
    act(() => root.render(React.createElement(Parent, { tick: 1 })));
    act(() => root.render(React.createElement(Parent, { tick: 2 })));
    act(() => root.unmount());

    assert.equal(seen.length, 1, 'memoized consumer must not re-render when provider props are unchanged');
});

test('react-native-web ESM and CJS LocaleProvider builds both memoize their context value', () => {
    for (const relativePath of LOCALE_MODULES) {
        const source = fs.readFileSync(path.join(PACKAGE_DIR, relativePath), 'utf8');
        assert.match(source, /useMemo/, `${relativePath} must memoize the LocaleContext value`);
    }
});
