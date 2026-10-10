import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

function createCssState(t, { ssr = '' } = {}) {
    const dom = new JSDOM(`<!doctype html><html><head>${ssr}</head><body></body></html>`);
    const previous = { window: globalThis.window, document: globalThis.document, screen: globalThis.screen };
    const originalLoad = Module._load;
    t.after(() => {
        Module._load = originalLoad;
        Object.assign(globalThis, previous);
        dom.window.close();
    });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, screen: dom.window.screen });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // JSDOM lacks innerText's browser stylesheet update; retain that DOM boundary's semantics.
    Object.defineProperty(dom.window.HTMLStyleElement.prototype, 'innerText', {
        get() { return this.textContent; },
        set(value) { this.textContent = value; },
    });
    // Same OS/platform boundary as the installed orientation test; all Unistyles logic is real.
    Module._load = function (request, parent, isMain) {
        if (request === 'react-native') return { StyleSheet: { compose() {}, flatten() {}, hairlineWidth: 1 } };
        return originalLoad.call(this, request, parent, isMain);
    };
    const packageDir = path.dirname(require.resolve('react-native-unistyles/package.json'));
    // Enter through the package's normal web entry to initialize its cyclic service graph.
    require(path.join(packageDir, 'lib/commonjs/web/index.js'));
    const { CSSState } = require(path.join(packageDir, 'lib/commonjs/web/css/state.js'));
    const { services } = require(path.join(packageDir, 'lib/commonjs/web/services.js'));
    const css = new CSSState(services);
    return { css, dom, sheet: () => document.getElementById('unistyles-web').sheet };
}

function styleRules(container, media = '') {
    if (typeof container === 'function') container = container();
    return Array.from(container.cssRules).flatMap(rule => rule.cssRules
        ? styleRules(rule, rule.conditionText === 'all' ? media : rule.conditionText)
        : [{ rule, media }]);
}

test('style registration and removal update only affected rules without serializing the stylesheet', (t) => {
    const { css, sheet } = createCssState(t);
    let serializations = 0;
    let serializedBytes = 0;
    const original = css.getStyles;
    css.getStyles = () => {
        serializations += 1;
        const text = original();
        serializedBytes += text.length;
        return text;
    };
    const start = performance.now();
    css.add('retained', { color: 'red', padding: 2 });
    const retained = styleRules(sheet).find(({ rule }) => rule.selectorText === '.retained').rule;
    for (let i = 0; i < 500; i += 1) css.add(`row_${i}`, { width: i + 1, opacity: 0.5 });
    for (let i = 0; i < 500; i += 1) css.remove(`row_${i}`);
    if (process.env.HAPPIER_MEASURE_UI_STARTUP_COST === '1') {
        console.log(JSON.stringify({ workload: '500 additions/removals', ms: performance.now() - start, serializations, serializedBytes }));
    }
    assert.equal(serializations, 0, 'registration churn must not serialize unrelated styles');
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.retained').rule, retained);
    assert.equal(styleRules(sheet).length, 1);
    assert.equal(retained.style.getPropertyValue('padding'), '2px');
});

test('incremental styles preserve media order, pseudo selectors, child selectors and replacements', (t) => {
    const { css, sheet } = createCssState(t);
    css.add('first', { color: 'red', _hover: { color: 'blue' } });
    css.add('children > *', { margin: 4 });
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'first', propertyKey: 'color', value: 'green' });
    css.set({ mediaQuery: '@media (min-width: 900px)', className: 'first', propertyKey: 'color', value: 'orange' });
    css.recreate();
    css.add('first', { color: 'purple' });
    const rules = styleRules(sheet);
    assert.equal(rules.find(({ rule, media }) => !media && rule.selectorText === '.first').rule.style.color, 'purple');
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.first:hover').rule.style.color, 'blue');
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.children > *').rule.style.margin, '4px');
    assert.deepEqual(rules.filter(({ media }) => media).map(({ rule, media }) => [media, rule.style.color]), [
        ['(min-width: 600px)', 'green'], ['(min-width: 900px)', 'orange'],
    ]);
    css.remove('first');
    assert.equal(styleRules(sheet).filter(({ rule }) => rule.selectorText === '.first').length, 0);
    css.add('first', { color: 'pink' });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.color, 'pink');
    css.set({ className: 'first', propertyKey: 'color', value: undefined });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.color, '');
    css.set({ className: 'first', propertyKey: 'color', value: 'red !important' });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.getPropertyPriority('color'), 'important');
});

test('theme rebuilds retain the cascade position of empty media buckets', (t) => {
    const { css, sheet } = createCssState(t);
    css.add('reused', { color: 'red' });
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'reused', propertyKey: 'color', value: 'green' });
    css.recreate();
    css.remove('reused');
    css.recreate();
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'reused', propertyKey: 'color', value: 'green' });
    css.add('reused', { color: 'red' });
    assert.deepEqual(styleRules(sheet).map(({ rule, media }) => [media, rule.style.color]), [
        ['', 'red'], ['(min-width: 600px)', 'green'],
    ]);
});

test('SSR hydration, theme recreation and reset keep the authoritative maps and live rules aligned', (t) => {
    const { css, sheet } = createCssState(t, { ssr: '<style id="unistyles-web">.hydrated{color:red}</style>' });
    css.hydrate({ mainState: [['', [['hydrated', [['color', 'red']]]]]], mqState: [] });
    css.addTheme('light', { colors: { foreground: 'red' } });
    css.recreate();
    css.add('after', { color: 'var(--colors-foreground)' });
    assert.equal(styleRules(sheet).filter(({ rule }) => rule.selectorText === '.hydrated').length, 1);
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.after').rule.style.color, 'var(--colors-foreground)');
    css.addTheme('light', { colors: { foreground: 'blue' } });
    css.recreate();
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === ':root.light').rule.style.getPropertyValue('--colors-foreground'), 'blue');
    css.reset();
    css.add('reset', { color: 'green' });
    const classes = styleRules(sheet).map(({ rule }) => rule.selectorText).filter(selector => selector.startsWith('.'));
    assert.deepEqual(classes, ['.reset']);
    assert.equal(css.getStyles().includes('.hydrated'), false);
});
